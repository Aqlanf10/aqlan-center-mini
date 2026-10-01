import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const { ensureSchema, getPool, recordToothCondition, resetPoolForTesting, ToothVisitConflict } = await import("../../lib/db");

let patientId: number;
let otherPatientId: number;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES
     ('CHART-PG-A', 'Synthetic chart A'), ('CHART-PG-B', 'Synthetic chart B') RETURNING id`,
  );
  [patientId, otherPatientId] = rows.map((row) => row.id);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const record = (visitId: number) => recordToothCondition({
  patientId, visitId, toothCode: 11, condition: "caries", stage: "existing", recordedBy: "chart-pg-test",
});
async function visit(owner: number) {
  return (await getPool().query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, status) VALUES ('Synthetic chart visit', $1, 'done') RETURNING id`, [owner],
  )).rows[0].id;
}
async function recorded(visitId: number) {
  return (await getPool().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM tooth_conditions WHERE visit_id = $1`, [visitId],
  )).rows[0].n;
}

describe("tooth chart ownership on real PostgreSQL", () => {
  it("rejects a foreign visit and accepts a same-patient visit", async () => {
    const foreign = await visit(otherPatientId);
    await expect(record(foreign)).rejects.toBeInstanceOf(ToothVisitConflict);
    expect(await recorded(foreign)).toBe(0);
    const own = await visit(patientId);
    expect(await record(own)).toMatchObject({ visitId: own });
    expect(await recorded(own)).toBe(1);
  });

  it("revalidates ownership after waiting for a concurrent visit update", async () => {
    const id = await visit(patientId);
    const writer = await getPool().connect();
    let pending: Promise<{ error: unknown } | { value: unknown }> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query(`SELECT id FROM visits WHERE id = $1 FOR UPDATE`, [id]);
      pending = record(id).then((value) => ({ value }), (error: unknown) => ({ error }));
      // Observe an actual server lock wait instead of guessing with a fixed sleep.
      let waiting = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { rows } = await getPool().query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query LIKE '%SELECT id FROM visits WHERE id = $1 AND patient_id = $2 FOR SHARE%') AS waiting`,
        );
        if (rows[0].waiting) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query(`UPDATE visits SET patient_id = $2 WHERE id = $1`, [id, otherPatientId]);
      await writer.query("COMMIT");
      const result = await pending;
      expect("error" in result && result.error).toBeInstanceOf(ToothVisitConflict);
      expect(await recorded(id)).toBe(0);
    } finally {
      await writer.query("ROLLBACK").catch(() => {});
      writer.release();
      await pending;
    }
  }, 20_000);
});
