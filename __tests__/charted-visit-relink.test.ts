import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
const { ensureSchema, getPool, recordToothCondition, linkVisitToPatient, resetPoolForTesting } = await import("../lib/db");
let patientId: number;
let otherPatientId: number;
beforeAll(async () => {
  await ensureSchema();
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES
     ('RELINK-CHART-A', 'Synthetic chart A'), ('RELINK-CHART-B', 'Synthetic chart B') RETURNING id`,
  );
  [patientId, otherPatientId] = rows.map((row) => row.id);
}, 60_000);
afterAll(async () => { await resetPoolForTesting(); });
const visit = async (owner: number | null) => (await getPool().query<{ id: number }>(
  `INSERT INTO visits (patient_name, patient_id, status) VALUES ('Synthetic visit', $1, 'done') RETURNING id`, [owner],
)).rows[0].id;

const chart = (visitId: number) => recordToothCondition({
  patientId, visitId, toothCode: 11, condition: "caries", stage: "existing", recordedBy: "relink-test",
});

describe("relinking a charted visit", () => {
  it("refuses moving an unsigned visit with chart history without rewriting either patient's records", async () => {
    const id = await visit(patientId);
    const recorded = await chart(id);
    expect(recorded).not.toBeNull();
    expect(await linkVisitToPatient(id, otherPatientId)).toMatchObject({ ok: false });
    const { rows: [row] } = await getPool().query<{ patient_id: number; chart_patient_id: number; record_id: string }>(
      `SELECT v.patient_id, t.patient_id AS chart_patient_id, t.id AS record_id
       FROM visits v JOIN tooth_conditions t ON t.visit_id = v.id WHERE v.id = $1`, [id],
    );
    expect(row.patient_id).toBe(patientId);
    expect(row.chart_patient_id).toBe(patientId);
    expect(Number(row.record_id)).toBe(recorded!.id);
    expect((await getPool().query(`SELECT id FROM tooth_conditions WHERE patient_id = $1`, [otherPatientId])).rows).toHaveLength(0);
  });

  it("allows a same-patient relink of an unsigned charted visit", async () => {
    const id = await visit(patientId);
    await chart(id);
    expect(await linkVisitToPatient(id, patientId)).toEqual({ ok: true, patientName: "Synthetic chart A" });
  });

  it("retains linking an empty visit and correcting an unsigned visit without chart history", async () => {
    const unlinked = await visit(null);
    expect(await linkVisitToPatient(unlinked, patientId)).toMatchObject({ ok: true });
    const empty = await visit(patientId);
    expect(await linkVisitToPatient(empty, otherPatientId)).toMatchObject({ ok: true });
    expect((await getPool().query<{ patient_id: number }>(`SELECT patient_id FROM visits WHERE id = $1`, [empty])).rows[0].patient_id)
      .toBe(otherPatientId);
  });

  it("retains signed-visit and missing-resource refusals", async () => {
    const id = await visit(patientId);
    await getPool().query(`UPDATE visits SET signed_at = NOW(), signed_by = 'test' WHERE id = $1`, [id]);
    expect(await linkVisitToPatient(id, otherPatientId)).toMatchObject({ ok: false });
    expect(await linkVisitToPatient(2_147_483_647, otherPatientId)).toMatchObject({ ok: false });
    expect(await linkVisitToPatient(await visit(null), 2_147_483_647)).toMatchObject({ ok: false });
  });
});
