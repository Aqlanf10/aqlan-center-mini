import { afterAll, beforeAll, expect, it } from "vitest";
import type { DbClient } from "../../lib/db";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const { ensureSchema, getPool, resetPoolForTesting, recordToothCondition, linkVisitToPatient } = await import("../../lib/db");
let patientId: number;
let otherPatientId: number;
let visitId: number;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES
     ('RELINK-RACE-A', 'Synthetic A'), ('RELINK-RACE-B', 'Synthetic B') RETURNING id`,
  );
  [patientId, otherPatientId] = rows.map((row) => row.id);
  visitId = (await getPool().query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, status) VALUES ('Synthetic', $1, 'done') RETURNING id`, [patientId],
  )).rows[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function waitForLock(queryFragment: string, observer: DbClient) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
       AND wait_event_type = 'Lock' AND query LIKE $1) AS waiting`, [`%${queryFragment}%`],
    );
    if (rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Did not observe the expected database lock: ${queryFragment}`);
}

it("a relinker waits for an in-flight chart insert, then refuses without moving clinical history", async () => {
  const gate = await getPool().connect();
  let chart: ReturnType<typeof recordToothCondition> | undefined;
  let relink: ReturnType<typeof linkVisitToPatient> | undefined;
  try {
    await gate.query(`SELECT pg_advisory_lock(716501)`);
    await getPool().query(`CREATE FUNCTION relink_test_pause_chart() RETURNS trigger AS $$
      BEGIN PERFORM pg_advisory_xact_lock(716501); RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await getPool().query(`CREATE TRIGGER relink_test_pause_chart BEFORE INSERT ON tooth_conditions
      FOR EACH ROW EXECUTE FUNCTION relink_test_pause_chart()`);
    chart = recordToothCondition({
      patientId, visitId, toothCode: 11, condition: "caries", stage: "existing", recordedBy: "relink-race",
    });
    void chart.catch(() => {});
    await waitForLock("INSERT INTO tooth_conditions", gate);
    relink = linkVisitToPatient(visitId, otherPatientId);
    void relink.catch(() => {});
    await waitForLock("SELECT signed_at, patient_id FROM visits WHERE id = $1 FOR UPDATE", gate);
    await gate.query(`SELECT pg_advisory_unlock(716501)`);
    expect(await chart).not.toBeNull();
    expect(await relink).toMatchObject({ ok: false });
    const { rows } = await getPool().query<{ patient_id: number; chart_patient_id: number }>(
      `SELECT v.patient_id, t.patient_id AS chart_patient_id FROM visits v
       JOIN tooth_conditions t ON t.visit_id = v.id WHERE v.id = $1`, [visitId],
    );
    expect(rows).toEqual([{ patient_id: patientId, chart_patient_id: patientId }]);
  } finally {
    await gate.query(`SELECT pg_advisory_unlock(716501)`).catch(() => {});
    await Promise.allSettled([chart, relink].filter(Boolean));
    await getPool().query(`DROP TRIGGER IF EXISTS relink_test_pause_chart ON tooth_conditions`);
    await getPool().query(`DROP FUNCTION IF EXISTS relink_test_pause_chart()`);
    gate.release();
  }
}, 25_000);
