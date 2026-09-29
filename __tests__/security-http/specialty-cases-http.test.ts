import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (CASE-MODEL-1) الحالات التخصصية وقائمة المشاكل وترتيب الخطة على التطبيق المبني:
 * من يقرأ، ومن يكتب، ومن لا يرى مريض غيره — وكل رفضٍ برسالة عربية بلا تفاصيل داخلية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let caseId = 0;
const itemIds: number[] = [];
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const post = (who: Who, path: string, body: unknown) => authedMutation(path, h.sessions[who], "POST", JSON.stringify(body));
const messageOf = async (response: Response) => (await response.json() as { message?: string }).message ?? "";

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض الحالات', $2) RETURNING id`,
    [`CS-${stamp}`, doctor.party_id]);
  patientId = patient.id;
  const { rows: [plan] } = await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, primary_doctor_id)
     VALUES ($1, 'خطة شاملة', 200000, 'YER', 'active', $2) RETURNING id`, [patientId, doctor.party_id]);
  for (const name of ["علاج عصب", "تاج"]) {
    const { rows: [item] } = await db.query<{ id: number }>(
      `INSERT INTO plan_items (plan_id, service_name, quantity, unit_price_minor) VALUES ($1, $2, 1, 100000) RETURNING id`,
      [plan.id, name]);
    itemIds.push(item.id);
  }
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("CASE-MODEL-1 — permissions and messages", () => {
  it("reception reads the cases but cannot write one (Arabic 403)", async () => {
    expect((await authedGet(`/api/patients/${patientId}/cases`, h.sessions.reception)).status).toBe(200);
    const response = await post("reception", `/api/patients/${patientId}/cases`, { specialty: "endodontics", title: "عصب" });
    expect(response.status).toBe(403);
    expect(await messageOf(response)).toContain("يكتبها الطبيب");
  });

  it("cashier and accountant are outside the clinical routes altogether", async () => {
    for (const who of ["cashier", "accountant"] as const) {
      const response = await authedGet(`/api/patients/${patientId}/cases`, h.sessions[who]);
      expect(response.status).toBe(403);
      expect(await messageOf(response)).toMatch(/[؀-ۿ]/);
    }
  });

  it("a doctor who does not own the patient can neither read nor write", async () => {
    expect((await authedGet(`/api/patients/${patientId}/cases`, h.sessions.doctorB)).status).toBe(403);
    expect((await post("doctorB", `/api/patients/${patientId}/cases`, { specialty: "endodontics", title: "عصب" })).status).toBe(403);
  });

  it("validation errors are Arabic 400s", async () => {
    const response = await post("doctorA", `/api/patients/${patientId}/cases`, { specialty: "magic", title: "x" });
    expect(response.status).toBe(400);
    expect(await messageOf(response)).toBe("اختر تخصص الحالة.");
  });

  it("the patient's doctor opens a case, links an item, adds a dependency, and a cycle is a 409", async () => {
    const created = await post("doctorA", `/api/patients/${patientId}/cases`, { specialty: "endodontics", title: "علاج عصب — ٢١", site: "21" });
    expect(created.status).toBe(201);
    caseId = (await created.json() as { id: number }).id;

    const linked = await authedMutation(`/api/plan-items/${itemIds[0]}/case`, h.sessions.doctorA, "PUT", JSON.stringify({ caseId, priority: 1 }));
    expect(linked.status).toBe(200);
    const badPriority = await authedMutation(`/api/plan-items/${itemIds[0]}/case`, h.sessions.doctorA, "PUT", JSON.stringify({ caseId, priority: 0 }));
    expect(badPriority.status).toBe(400);

    expect((await post("doctorA", `/api/plan-items/${itemIds[1]}/dependencies`, { requiresItemId: itemIds[0] })).status).toBe(201);
    const cycle = await post("doctorA", `/api/plan-items/${itemIds[0]}/dependencies`, { requiresItemId: itemIds[1] });
    expect(cycle.status).toBe(409);
    expect(await messageOf(cycle)).toContain("دورة");

    const view = await (await authedGet(`/api/patients/${patientId}/cases`, h.sessions.reception)).json() as {
      cases: { id: number | null; title: string }[]; dependencies: { itemId: number; met: boolean }[];
    };
    expect(view.cases.map((one) => one.title)).toContain("علاج عصب — ٢١");
    expect(view.dependencies).toEqual([expect.objectContaining({ itemId: itemIds[1], met: false })]);

    const removed = await authedMutation(`/api/plan-items/${itemIds[1]}/dependencies?requires=${itemIds[0]}`, h.sessions.doctorA, "DELETE");
    expect(removed.status).toBe(200);
  });

  it("problems: doctor adds, reception cannot, status change is audited; a finished case cannot reopen (409)", async () => {
    const denied = await post("reception", `/api/patients/${patientId}/problems`, { label: "التهاب لب" });
    expect(denied.status).toBe(403);
    const created = await post("doctorA", `/api/patients/${patientId}/problems`, { label: "التهاب لب", site: "21", caseId });
    expect(created.status).toBe(201);
    const problemId = (await created.json() as { id: number }).id;
    const resolved = await authedMutation(`/api/problems/${problemId}`, h.sessions.doctorA, "PATCH", JSON.stringify({ status: "resolved" }));
    expect(resolved.status).toBe(200);
    const again = await authedMutation(`/api/problems/${problemId}`, h.sessions.doctorA, "PATCH", JSON.stringify({ status: "resolved" }));
    expect(again.status).toBe(409);

    const cancelNoReason = await authedMutation(`/api/cases/${caseId}`, h.sessions.doctorA, "PATCH", JSON.stringify({ status: "cancelled" }));
    expect(cancelNoReason.status).toBe(400);
    expect((await authedMutation(`/api/cases/${caseId}`, h.sessions.doctorA, "PATCH", JSON.stringify({ status: "completed", outcome: "تم" }))).status).toBe(200);
    const reopen = await authedMutation(`/api/cases/${caseId}`, h.sessions.doctorA, "PATCH", JSON.stringify({ status: "active" }));
    expect(reopen.status).toBe(409);
    expect(await messageOf(reopen)).toContain("لا تُعاد فتحها");

    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action IN ('case.create', 'case.status', 'problem.create', 'problem.status', 'plan.item_case', 'plan.dependency_add', 'plan.dependency_remove') ORDER BY id`,
      [String(patientId)]);
    expect(rows.map((row) => row.action)).toEqual([
      "case.create", "plan.item_case", "plan.dependency_add", "plan.dependency_remove",
      "problem.create", "problem.status", "case.status",
    ]);
  });

  it("unknown ids are Arabic 404s without internals", async () => {
    const response = await authedMutation(`/api/cases/999999`, h.sessions.admin, "PATCH", JSON.stringify({ status: "waiting" }));
    expect(response.status).toBe(404);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["message"]);
    expect(String(body.message)).toMatch(/[؀-ۿ]/);
  });
});
