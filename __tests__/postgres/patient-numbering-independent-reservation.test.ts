import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { createIndependentPgReservationBackend } from "../../lib/restore/numbering-pg-reservation";
import { reserveRestoredNumber } from "../../lib/restore/numbering-reservation";
import type { PrefixSnapshot } from "../../lib/patient-numbering-policy";

// Real PostgreSQL protocol witness, synthetic local CI only. A unique schema
// stands in for the external authority; this does NOT prove independent
// storage, failover durability, or fencing of existing application writers.
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
const schema = "synthetic_numbering_" + randomUUID().replaceAll("-", "");
const pool = new Pool({ connectionString: target.testUrl.toString(), ssl: false,
  max: 8, connectionTimeoutMillis: 5000, options: "-c statement_timeout=30000 -c lock_timeout=20000" });
const secondPool = new Pool({ connectionString: target.testUrl.toString(), ssl: false,
  max: 4, connectionTimeoutMillis: 5000, options: "-c statement_timeout=30000 -c lock_timeout=20000" });
const backend = createIndependentPgReservationBackend(pool, schema);
const other = createIndependentPgReservationBackend(secondPool, schema);
const admission = '"' + schema + '".generation_admission';
const watermarks = '"' + schema + '".numbering_watermarks';
const generation = "synthetic_generation_001";
const nextGeneration = "synthetic_generation_002";
const archive: PrefixSnapshot = { prefix: "P", allocatedThrough: 7027n,
  historicalThrough: 7027n, pendingNext: null, historyComplete: true, revision: "synthetic-r1" };
let created = false;

async function seed(lineage: string, through: string) {
  await pool.query(`INSERT INTO ${admission}(lineage,generation) VALUES($1,$2)`, [lineage,generation]);
  await pool.query(`INSERT INTO ${watermarks}(lineage,prefix,reserved_through) VALUES($1,'P',$2::bigint)`, [lineage,through]);
  return { lineage, generation };
}
async function read(lineage: string) {
  return (await pool.query<{ reserved_through: string }>(
    `SELECT reserved_through::text FROM ${watermarks} WHERE lineage=$1 AND prefix='P'`, [lineage])).rows[0]?.reserved_through;
}

beforeAll(async () => {
  // No IF NOT EXISTS: never adopt or remove a pre-existing schema.
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await pool.query(`CREATE TABLE ${admission} (lineage text PRIMARY KEY, generation text NOT NULL)`);
  await pool.query(`CREATE TABLE ${watermarks} (lineage text REFERENCES ${admission}(lineage),
    prefix text NOT NULL, reserved_through bigint NOT NULL CHECK(reserved_through BETWEEN 0 AND 999999999999999999),
    PRIMARY KEY(lineage,prefix))`);
});
afterAll(async () => {
  try {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await Promise.all([pool.end(), secondPool.end()]);
  }
});

describe("independent numbering reservation: real PostgreSQL, synthetic only", () => {
  it("issues 7000 and 7001 with an uncalled pending floor, then never rewinds", async () => {
    const binding = await seed("synthetic_lineage_start", "6999");
    const initial = { ...archive, allocatedThrough: 42n, historicalThrough: 42n, pendingNext: 7000n };
    expect(await reserveRestoredNumber(initial,binding,backend)).toEqual({ok:true,reserved:"7000",prefix:"P"});
    expect(await reserveRestoredNumber(initial,binding,other)).toEqual({ok:true,reserved:"7001",prefix:"P"});
    expect(await read(binding.lineage)).toBe("7001");
  });

  it("serializes concurrent reservations across separate pools after an old archive", async () => {
    const binding = await seed("synthetic_lineage_concurrency", "7029");
    const results = await Promise.all(Array.from({length: 16}, (_, i) =>
      reserveRestoredNumber(archive,binding,i % 2 ? backend : other)));
    const issued = results.map(result => {
      if (!result.ok) throw new Error(result.reason);
      return Number(result.reserved);
    }).sort((a,b) => a-b);
    expect(issued).toEqual(Array.from({length:16},(_,i)=>7030+i));
    expect(await read(binding.lineage)).toBe("7045");
  });

  it("rolls back a failed transaction, then preserves committed reservations", async () => {
    const binding = await seed("synthetic_lineage_rollback", "7029");
    await expect(backend.transaction(binding, async tx => {
      const witness = await tx.readFresh("P");
      if (!witness) throw new Error("missing witness");
      expect(await tx.advance(witness,7030n)).toBe(true);
      throw new Error("synthetic abort before commit");
    })).rejects.toThrow("synthetic abort before commit");
    expect(await read(binding.lineage)).toBe("7029");
    expect(await reserveRestoredNumber(archive,binding,other)).toEqual({ok:true,reserved:"7030",prefix:"P"});
    expect(await reserveRestoredNumber(archive,binding,backend)).toEqual({ok:true,reserved:"7031",prefix:"P"});
    expect(await read(binding.lineage)).toBe("7031");
  });

  it("burns a committed reservation if the COMMIT acknowledgement is lost", async () => {
    const binding = await seed("synthetic_lineage_commit_loss", "7029");
    // Forward every SQL operation to real PostgreSQL. Lose only the response
    // after PostgreSQL has successfully committed; no fake watermark writes.
    const lostResponsePool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, args?: unknown[]) {
            const result = await client.query(sql, args);
            if (sql === "COMMIT") {
              expect(result.command).toBe("COMMIT");
              throw new Error("synthetic lost commit acknowledgement");
            }
            return result;
          },
          release(discard?: boolean) { client.release(discard); },
        };
      },
    } as unknown as Pick<Pool, "connect">;
    const lost = createIndependentPgReservationBackend(lostResponsePool, schema);
    expect(await reserveRestoredNumber(archive, binding, lost))
      .toEqual({ ok: false, reason: "watermark-reservation-unconfirmed" });
    // A separate connection sees the committed burn even though the caller
    // got no number; an independent retry must skip it.
    expect(await read(binding.lineage)).toBe("7030");
    expect(await reserveRestoredNumber(archive, binding, other))
      .toEqual({ ok: true, reserved: "7031", prefix: "P" });
    expect(await read(binding.lineage)).toBe("7031");
  });

  it("rolls back a real UPDATE whose acknowledgement is lost even if the callback catches it", async () => {
    const binding = await seed("synthetic_lineage_update_loss", "7029");
    const lostResponsePool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql: string, args?: unknown[]) {
            const result = await client.query(sql, args);
            if (sql.startsWith("UPDATE")) {
              expect(result.command).toBe("UPDATE");
              expect(result.rowCount).toBe(1);
              throw new Error("synthetic lost update acknowledgement");
            }
            return result;
          },
          release(discard?: boolean) { client.release(discard); },
        };
      },
    } as unknown as Pick<Pool, "connect">;
    const lost = createIndependentPgReservationBackend(lostResponsePool, schema);
    await expect(lost.transaction(binding, async tx => {
      const witness = await tx.readFresh("P");
      if (!witness) throw new Error("missing witness");
      await expect(tx.advance(witness, 7030n)).rejects.toThrow("synthetic lost update acknowledgement");
      return "must not escape";
    })).rejects.toThrow("Authority advance not confirmed");
    // The UPDATE reached PostgreSQL, but the adapter must roll it back rather
    // than expose a reservation. A separate pool sees only the committed floor.
    expect(await read(binding.lineage)).toBe("7029");
    expect(await reserveRestoredNumber(archive, binding, other))
      .toEqual({ ok: true, reserved: "7030", prefix: "P" });
    expect(await read(binding.lineage)).toBe("7030");
  });

  it("rejects the retired generation and preserves the watermark on replacement", async () => {
    const binding = await seed("synthetic_lineage_generation", "7029");
    expect((await reserveRestoredNumber(archive,binding,backend)).ok).toBe(true);
    // UPDATE obtains the same row lock as the adapter's admission SELECT.
    await pool.query(`UPDATE ${admission} SET generation=$2 WHERE lineage=$1`, [binding.lineage,nextGeneration]);
    expect(await reserveRestoredNumber(archive,binding,backend)).toEqual({ok:false,reason:"watermark-reservation-unconfirmed"});
    expect(await read(binding.lineage)).toBe("7030");
    expect(await reserveRestoredNumber(archive,{...binding,generation:nextGeneration},other))
      .toEqual({ok:true,reserved:"7031",prefix:"P"});
  });

  it("holds generation admission until the reservation commits across separate pools", async () => {
    const binding = await seed("synthetic_lineage_fence", "7029");
    await backend.transaction(binding, async tx => {
      const witness = await tx.readFresh("P");
      if (!witness) throw new Error("missing synthetic witness");
      expect(await tx.advance(witness, 7030n)).toBe(true);
      // A separate connection cannot acquire the admission row while this
      // reservation is uncommitted. NOWAIT makes the witness deterministic.
      await expect(secondPool.query(
        `SELECT generation FROM ${admission} WHERE lineage=$1 FOR UPDATE NOWAIT`,
        [binding.lineage],
      )).rejects.toMatchObject({ code: "55P03" });
    });
    expect(await read(binding.lineage)).toBe("7030");
    await secondPool.query(`UPDATE ${admission} SET generation=$2 WHERE lineage=$1`,
      [binding.lineage, nextGeneration]);
    expect(await reserveRestoredNumber(archive, binding, backend))
      .toEqual({ ok: false, reason: "watermark-reservation-unconfirmed" });
    expect(await reserveRestoredNumber(archive, { ...binding, generation: nextGeneration }, other))
      .toEqual({ ok: true, reserved: "7031", prefix: "P" });
  });

  it("reserves the last supported number once and refuses exhaustion without rewinding", async () => {
    const binding = await seed("synthetic_lineage_exhaustion", "999999999999999998");
    expect(await reserveRestoredNumber(archive, binding, backend))
      .toEqual({ ok: true, reserved: "999999999999999999", prefix: "P" });
    expect(await reserveRestoredNumber(archive, binding, other))
      .toEqual({ ok: false, reason: "numbering-exhausted" });
    expect(await read(binding.lineage)).toBe("999999999999999999");
  });

  it("does not advance a different lineage with the same prefix", async () => {
    const first = await seed("synthetic_lineage_isolation_a", "7029");
    const second = await seed("synthetic_lineage_isolation_b", "7029");
    expect(await reserveRestoredNumber(archive, first, backend))
      .toEqual({ ok: true, reserved: "7030", prefix: "P" });
    expect(await read(second.lineage)).toBe("7029");
    expect(await reserveRestoredNumber(archive, second, other))
      .toEqual({ ok: true, reserved: "7030", prefix: "P" });
    expect(await read(first.lineage)).toBe("7030");
    expect(await read(second.lineage)).toBe("7030");
  });

  it("fails closed if the authority row is absent or behind the archive", async () => {
    const absent = { lineage: "synthetic_lineage_missing", generation };
    expect((await reserveRestoredNumber(archive,absent,backend)).ok).toBe(false);
    const stale = await seed("synthetic_lineage_stale", "7026");
    expect(await reserveRestoredNumber(archive,stale,other)).toEqual({ok:false,reason:"watermark-behind-archive"});
    expect(await read(stale.lineage)).toBe("7026");
  });
});
