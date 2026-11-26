import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createIndependentPgReservationBackend } from "../lib/restore/numbering-pg-reservation";
import { reserveRestoredNumber } from "../lib/restore/numbering-reservation";

const binding = { lineage: "synthetic_lineage_001", generation: "synthetic_generation_002" };
const archive = { prefix: "P", allocatedThrough: 7027n, historicalThrough: 7027n,
  pendingNext: null, historyComplete: true, revision: "synthetic-r1" };
function fixture(options: { generation?: string; watermark?: unknown; commitLost?: boolean; commitRollback?: boolean; missing?: boolean; conflict?: boolean } = {}) {
  const calls: Array<{ sql: string; args?: unknown[] }> = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    calls.push({ sql, args });
    if (sql.includes("SELECT generation")) return { rows: [{ generation: options.generation ?? binding.generation }] };
    if (sql.includes("SELECT reserved_through")) return { rows: options.missing ? [] : [{ reserved_through: options.watermark === undefined ? "7029" : options.watermark }] };
    if (sql.startsWith("UPDATE")) return { rowCount: options.conflict ? 0 : 1 };
    if (sql === "COMMIT") {
      if (options.commitLost) throw new Error("synthetic lost response");
      return { command: options.commitRollback ? "ROLLBACK" : "COMMIT" };
    }
    return { rows: [] };
  });
  const connect = vi.fn(async () => ({ query, release }));
  const pool = { connect } as unknown as Pick<Pool, "connect">;
  return { backend: createIndependentPgReservationBackend(pool, "synthetic_authority"), calls, release, connect, pool };
}
describe("independent PG reservation SQL protocol (mock, no database)", () => {
  it("locks generation before watermark, advances with CAS and commits before returning", async () => {
    const f = fixture();
    expect(await reserveRestoredNumber(archive, binding, f.backend))
      .toEqual({ ok: true, reserved: "7030", prefix: "P" });
    expect(f.calls.map(c => c.sql.split(/\s+/)[0])).toEqual(["BEGIN", "SET", "SELECT", "SELECT", "UPDATE", "COMMIT"]);
    expect(f.calls[2].sql).toContain("FOR UPDATE");
    expect(f.calls[3].sql).toContain("FOR UPDATE");
    expect(f.calls[4].args).toEqual([binding.lineage, "P", "7030", "7029"]);
    expect(f.release).toHaveBeenCalledWith(false);
  });
  it("allows only one advance attempt per transaction even when callers overlap", async () => {
    const f = fixture();
    const result = await f.backend.transaction(binding, async tx => {
      const witness = await tx.readFresh("P");
      if (!witness) throw new Error("missing synthetic witness");
      const results = await Promise.all([tx.advance(witness, 7030n), tx.advance(witness, 7031n)]);
      await expect(tx.readFresh("P")).rejects.toThrow("Invalid watermark read");
      expect(await tx.advance(witness, 7032n)).toBe(false);
      return results;
    });
    expect(result).toEqual([true, false]);
    expect(f.calls.filter(c => c.sql.startsWith("UPDATE"))).toHaveLength(1);
    expect(f.calls.at(-1)?.sql).toBe("COMMIT");
  });
  it("does not retry an unsuccessful CAS in the same transaction", async () => {
    const f = fixture({ conflict: true });
    await f.backend.transaction(binding, async tx => {
      const witness = await tx.readFresh("P");
      if (!witness) throw new Error("missing synthetic witness");
      expect(await tx.advance(witness, 7030n)).toBe(false);
      expect(await tx.advance(witness, 7031n)).toBe(false);
      await expect(tx.readFresh("P")).rejects.toThrow("Invalid watermark read");
    });
    expect(f.calls.filter(c => c.sql.startsWith("UPDATE"))).toHaveLength(1);
  });
  it("rejects overlapping reads without changing the selected witness", async () => {
    const f = fixture();
    await f.backend.transaction(binding, async tx => {
      const first = tx.readFresh("P");
      await expect(tx.readFresh("Q")).rejects.toThrow("Invalid watermark read");
      const witness = await first;
      if (!witness) throw new Error("missing synthetic witness");
      expect(witness.prefix).toBe("P");
      expect(await tx.advance(witness, 7030n)).toBe(true);
    });
    expect(f.calls.filter(c => c.sql.includes("SELECT reserved_through"))).toHaveLength(1);
  });
  it("rejects stale generation before touching watermark", async () => {
    const f = fixture({ generation: "synthetic_generation_001" });
    expect(await reserveRestoredNumber(archive, binding, f.backend)).toEqual({ ok: false, reason: "watermark-reservation-unconfirmed" });
    expect(f.calls.some(c => c.sql.includes("numbering_watermarks"))).toBe(false);
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  it("does not initialize an absent watermark", async () => {
    const f = fixture({ missing: true });
    expect(await reserveRestoredNumber(archive, binding, f.backend)).toEqual({ ok: false, reason: "independent-watermark-unavailable" });
    expect(f.calls.some(c => c.sql.startsWith("UPDATE"))).toBe(false);
  });
  it("rejects a failed compare-and-swap", async () => {
    const f = fixture({ conflict: true });
    expect(await reserveRestoredNumber(archive, binding, f.backend)).toEqual({ ok: false, reason: "watermark-reservation-conflict" });
  });
  it.each([{ commitLost: true }, { commitRollback: true }])("never exposes a number on an uncertain or rolled-back commit: %j", async options => {
    const f = fixture(options);
    expect(await reserveRestoredNumber(archive, binding, f.backend)).toEqual({ ok: false, reason: "watermark-reservation-unconfirmed" });
    expect(f.release).toHaveBeenCalledWith(true);
  });
  it.each([7029, 7029n, null, { toString: () => "7029" }])("rejects non-text authority values without writing: %s", async watermark => {
    const f = fixture({ watermark });
    expect(await reserveRestoredNumber(archive, binding, f.backend))
      .toEqual({ ok: false, reason: "independent-watermark-unavailable" });
    expect(f.calls.some(c => c.sql.startsWith("UPDATE"))).toBe(false);
  });
  it("rejects coercible schema and prefix before sending SQL", async () => {
    const f = fixture();
    const fakeSchema = { toString: () => "synthetic_authority" } as unknown as string;
    expect(() => createIndependentPgReservationBackend(f.pool, fakeSchema)).toThrow("Invalid authority schema");
    await f.backend.transaction(binding, async tx => {
      const fakePrefix = { toString: () => "P" } as unknown as string;
      await expect(tx.readFresh(fakePrefix)).rejects.toThrow("Invalid watermark read");
    });
    expect(f.calls.some(c => c.sql.includes("SELECT reserved_through"))).toBe(false);
  });
  it("rejects unsafe schema or malformed binding", async () => {
    const f = fixture();
    expect(() => createIndependentPgReservationBackend(f.pool, "bad;schema")).toThrow();
    expect((await reserveRestoredNumber(archive, { ...binding, lineage: "bad" }, f.backend)).ok).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
  });
});
