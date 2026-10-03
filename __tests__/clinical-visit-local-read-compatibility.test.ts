import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateOperationalVerificationEnvironment } from "../lib/verification-target-policy.mjs";

// Inspect inherited target markers before choosing the in-memory adapter.
// Linked synthetic fixtures only. No network, HTTP, schema DROP, or local files.
validateOperationalVerificationEnvironment(process.env);
vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("SKIP_SEED", "true");
const db = await import("../lib/db");
let sequence = 0;
beforeAll(async () => { await db.ensureSchema(); }, 60_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await db.resetPoolForTesting();
  vi.unstubAllEnvs();
});
async function linkedVisit() {
  const pool = db.getPool();
  const { rows: [patient] } = await pool.query<{ id: number }>(`INSERT INTO patients(patient_number,full_name)
    VALUES($1,'Synthetic local coherent reader') RETURNING id`, [`LOCAL-COHERENT-${++sequence}`]);
  const { rows: [visit] } = await pool.query<{ id: number }>(`INSERT INTO visits(patient_id,patient_name,diagnosis)
    VALUES($1,'Synthetic local coherent reader','Synthetic committed diagnosis') RETURNING id`, [patient.id]);
  return { patientId: patient.id, visitId: visit.id };
}

describe("PGlite canonical read keeps the existing shared-executor behavior", () => {
  it("does not connect or delimit a transaction, even if USE_LOCAL_DB changes after pool creation", async () => {
    const f = await linkedVisit();
    const pool = db.getPool();
    const query = pool.query.bind(pool);
    const statements: string[] = [];
    const connect = vi.spyOn(pool, "connect").mockImplementation(async () => { throw new Error("Local read must not acquire a pseudo-client"); });
    const queries = vi.spyOn(pool, "query").mockImplementation(async (sql, values) => {
      statements.push(sql);
      return query(sql, values);
    });
    vi.stubEnv("USE_LOCAL_DB", "false");
    try {
      expect(db.getPool()).toBe(pool);
      expect(await db.getClinicalVisit(f.visitId)).toMatchObject({ id: f.visitId, patientId: f.patientId,
        diagnosis: "Synthetic committed diagnosis", procedures: [] });
      expect(await db.getClinicalVisit(2147483647)).toBeNull();
      expect(connect).not.toHaveBeenCalled();
      expect(statements.length).toBeGreaterThan(1);
      expect(statements.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
    } finally { vi.stubEnv("USE_LOCAL_DB", "true"); queries.mockRestore(); connect.mockRestore(); }
  });

  it("does not commit or roll back a pre-existing local writer's transaction", async () => {
    const f = await linkedVisit();
    const pool = db.getPool();
    const writer = await pool.connect();
    await writer.query("BEGIN");
    await writer.query("UPDATE visits SET diagnosis='Synthetic pending writer diagnosis' WHERE id=$1", [f.visitId]);
    const connect = vi.spyOn(pool, "connect").mockImplementation(async () => { throw new Error("Local read must not acquire a pseudo-client"); });
    const queries = vi.spyOn(pool, "query");
    try {
      // Shared-executor compatibility, deliberately NOT an MVCC snapshot claim.
      expect(await db.getClinicalVisit(f.visitId)).toMatchObject({ diagnosis: "Synthetic pending writer diagnosis" });
      expect(connect).not.toHaveBeenCalled();
      expect(queries.mock.calls.every(([sql]) => /^\s*SELECT\b/i.test(sql))).toBe(true);
      await writer.query("ROLLBACK");
    } finally {
      queries.mockRestore(); connect.mockRestore();
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
    expect(await db.getClinicalVisit(f.visitId)).toMatchObject({ diagnosis: "Synthetic committed diagnosis" });
  });
});
