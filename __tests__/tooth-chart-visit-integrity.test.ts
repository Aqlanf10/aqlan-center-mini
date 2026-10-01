import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
const { ensureSchema, getPool, recordToothCondition, resetPoolForTesting } = await import("../lib/db");

let patientId: number;
let otherPatientId: number;
let visitId: number;
let otherVisitId: number;
let unlinkedVisitId: number;

beforeAll(async () => {
  await ensureSchema();
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES
     ('CHART-LINK-A', 'Synthetic chart A'), ('CHART-LINK-B', 'Synthetic chart B') RETURNING id`,
  );
  [patientId, otherPatientId] = rows.map((row) => row.id);
  const visits = await getPool().query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, status) VALUES
     ('Synthetic chart A', $1, 'done'), ('Synthetic chart B', $2, 'done'),
     ('Synthetic unlinked', NULL, 'done') RETURNING id`, [patientId, otherPatientId],
  );
  [visitId, otherVisitId, unlinkedVisitId] = visits.rows.map((row) => row.id);
}, 60_000);
afterAll(async () => { await resetPoolForTesting(); });

const record = (visit?: number | null, patient = patientId) => recordToothCondition({
  patientId: patient, toothCode: 11, condition: "caries", stage: "existing", visitId: visit,
  recordedBy: "chart-integrity-test",
});
const count = async () => (await getPool().query<{ n: number }>(
  `SELECT COUNT(*)::int AS n FROM tooth_conditions`,
)).rows[0].n;

describe("tooth chart visit ownership", () => {
  it("rejects another patient's visit without recording a clinical event", async () => {
    const before = await count();
    await expect(record(otherVisitId)).rejects.toThrow("الزيارة غير موجودة أو لا تخص هذا المريض.");
    expect(await count()).toBe(before);
  });

  it("rejects nonexistent and unlinked visits with the same non-disclosing error", async () => {
    const before = await count();
    for (const id of [2_147_483_647, unlinkedVisitId]) {
      await expect(record(id)).rejects.toThrow("الزيارة غير موجودة أو لا تخص هذا المريض.");
    }
    expect(await count()).toBe(before);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid visit ID %s in the service", async (id) => {
      const before = await count();
      await expect(record(id)).rejects.toThrow("الزيارة غير موجودة أو لا تخص هذا المريض.");
      expect(await count()).toBe(before);
    },
  );

  it("retains same-patient links, including append-only corrections after signature", async () => {
    expect(await record(visitId)).toMatchObject({ visitId, toothCode: 11 });
    await getPool().query(`UPDATE visits SET signed_at = NOW(), signed_by = 'test' WHERE id = $1`, [visitId]);
    expect(await record(visitId)).toMatchObject({ visitId, toothCode: 11 });
    const { rows } = await getPool().query<{ patient_id: number; visit_patient_id: number }>(
      `SELECT t.patient_id, v.patient_id AS visit_patient_id
       FROM tooth_conditions t JOIN visits v ON v.id = t.visit_id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.patient_id === row.visit_patient_id)).toBe(true);
  });

  it("retains standalone chart events and missing-patient behavior", async () => {
    expect(await record()).toMatchObject({ visitId: null });
    expect(await record(null)).toMatchObject({ visitId: null });
    expect(await record(null, 2_147_483_647)).toBeNull();
  });
});
