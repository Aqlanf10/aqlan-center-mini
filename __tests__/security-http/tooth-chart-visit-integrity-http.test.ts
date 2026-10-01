import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness, TEST_USERS } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let ownVisitId: number;
let otherVisitId: number;
let unlinkedVisitId: number;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, status) VALUES
     ('Synthetic chart A', $1, 'done'), ('Synthetic chart B', $2, 'done'),
     ('Synthetic chart unlinked', NULL, 'done') RETURNING id`,
    [h.seeded.patientAId, h.seeded.patientBId],
  );
  [ownVisitId, otherVisitId, unlinkedVisitId] = rows.map((row) => row.id);
}, 120_000);
afterAll(async () => { await db?.end(); });

const post = (extra: Record<string, unknown> = {}, role: "doctorA" | "admin" = "doctorA") => authedMutation(
  `/api/patients/${h.seeded.patientAId}/chart`, h.sessions[role], "POST",
  JSON.stringify({ toothCode: 11, condition: "caries", stage: "existing", ...extra }),
);
async function counts() {
  return (await db.query<{ records: number; audits: number }>(
    `SELECT (SELECT COUNT(*)::int FROM tooth_conditions WHERE patient_id = $1) AS records,
     (SELECT COUNT(*)::int FROM audit_log WHERE action = 'chart.record' AND entity_id = $1::text) AS audits`,
    [h.seeded.patientAId],
  )).rows[0];
}

describe("tooth chart nested visit boundary over HTTP", () => {
  it("refuses another patient's visit even when the URL patient is authorized", async () => {
    const before = await counts();
    for (const role of ["doctorA", "admin"] as const) {
      const response = await post({ visitId: otherVisitId }, role);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: "الزيارة غير موجودة أو لا تخص هذا المريض." });
    }
    expect(await counts()).toEqual(before);
  });

  it("returns the same conflict for missing/unlinked visits without clinical or audit writes", async () => {
    const before = await counts();
    for (const visitId of [2_147_483_647, unlinkedVisitId]) {
      const response = await post({ visitId });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: "الزيارة غير موجودة أو لا تخص هذا المريض." });
    }
    expect(await counts()).toEqual(before);
  });

  it("rejects malformed explicit visit IDs instead of silently making standalone events", async () => {
    const before = await counts();
    for (const visitId of [0, -1, 1.5, 2_147_483_648, "", "bad", "1.5", true, false, [], [ownVisitId], {}]) {
      const response = await post({ visitId });
      expect(response.status, JSON.stringify(visitId)).toBe(400);
      expect(await response.json()).toEqual({ message: "رقم الزيارة غير صالح." });
    }
    expect(await counts()).toEqual(before);
  });

  it("keeps matching numeric/string links and omitted/null links, with the authenticated author", async () => {
    const before = await counts();
    for (const extra of [{ visitId: ownVisitId }, { visitId: String(ownVisitId) }, {}, { visitId: null }]) {
      const response = await post(extra);
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        toothCode: 11, visitId: extra.visitId == null ? null : ownVisitId,
        recordedBy: TEST_USERS.doctorA.username,
      });
    }
    const after = await counts();
    expect(after.records - before.records).toBe(4);
    expect(after.audits - before.audits).toBe(4);
  });
});
