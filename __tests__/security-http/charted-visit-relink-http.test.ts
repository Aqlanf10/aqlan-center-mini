import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 120_000);
afterAll(async () => { await db?.end(); });

it("charted unsigned visits cannot move patients; same-patient and empty-visit linking still work", async () => {
  const { rows: [visit] } = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, status) VALUES ('Synthetic relink', $1, 'done') RETURNING id`,
    [h.seeded.patientAId],
  );
  const recorded = await authedMutation(`/api/patients/${h.seeded.patientAId}/chart`, h.sessions.admin,
    "POST", JSON.stringify({ toothCode: 11, condition: "caries", stage: "existing", visitId: visit.id }));
  expect(recorded.status).toBe(201);
  const link = (id: number, patientId: number) => authedMutation(`/api/visits/${id}`, h.sessions.admin,
    "PATCH", JSON.stringify({ action: "link", patientId }));
  const refused = await link(visit.id, h.seeded.patientBId);
  expect(refused.status).toBe(409);
  expect((await refused.json()).message).toContain("مخطط الأسنان");
  const { rows } = await db.query<{ patient_id: number; chart_patient_id: number }>(
    `SELECT v.patient_id, t.patient_id AS chart_patient_id FROM visits v
     JOIN tooth_conditions t ON t.visit_id = v.id WHERE v.id = $1`, [visit.id],
  );
  expect(rows).toEqual([{ patient_id: h.seeded.patientAId, chart_patient_id: h.seeded.patientAId }]);
  expect((await link(visit.id, h.seeded.patientAId)).status).toBe(200);
  const { rows: [empty] } = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, status) VALUES ('Synthetic empty visit', 'done') RETURNING id`,
  );
  expect((await link(empty.id, h.seeded.patientBId)).status).toBe(200);
});
