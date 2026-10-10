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
    const category = name === "علاج عصب" ? "rct" : "crown";
    const { rows: [service] } = await db.query<{ id: number }>(
      `INSERT INTO services(name,category,price_minor) VALUES($1,$2,100000) RETURNING id`, [name, category]);
    const { rows: [item] } = await db.query<{ id: number }>(
      `INSERT INTO plan_items (plan_id, service_id, service_name, category, tooth_code, quantity, unit_price_minor)
       VALUES ($1, $2, $3, $4, 21, 1, 100000) RETURNING id`,
      [plan.id, service.id, name, category]);
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

  it("the doctor's plan permissions apply here too: no view ⇒ items hidden; no edit ⇒ 403 on item links and dependencies", async () => {
    const { rows: [user] } = await db.query<{ permissions: string | null }>(`SELECT permissions FROM users WHERE username = 'secdoctora'`);
    const original = user.permissions;
    const permissions = { ...(JSON.parse(original ?? "{}") as Record<string, unknown>), canViewPlans: false, canEditPlans: false };
    await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [JSON.stringify(permissions)]);
    try {
      const view = await (await authedGet(`/api/patients/${patientId}/cases`, h.sessions.doctorA)).json() as {
        items: unknown[]; dependencies: unknown[]; planVisible: boolean; cases: unknown[];
      };
      expect(view).toMatchObject({ items: [], dependencies: [], planVisible: false });
      expect(view.cases.length).toBeGreaterThan(0);
      const link = await authedMutation(`/api/plan-items/${itemIds[0]}/case`, h.sessions.doctorA, "PUT", JSON.stringify({ caseId: null, priority: null }));
      expect(link.status).toBe(403);
      expect(await messageOf(link)).toContain("تعديل خطط العلاج");
      expect((await post("doctorA", `/api/plan-items/${itemIds[1]}/dependencies`, { requiresItemId: itemIds[0] })).status).toBe(403);
    } finally {
      await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [original]);
    }
  });

  it("unknown ids are Arabic 404s without internals", async () => {
    const response = await authedMutation(`/api/cases/999999`, h.sessions.admin, "PATCH", JSON.stringify({ status: "waiting" }));
    expect(response.status).toBe(404);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["message"]);
    expect(String(body.message)).toMatch(/[؀-ۿ]/);
  });
});


let identitySeq = 0;
async function identityFixture() {
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username='secdoctora'`);
  const patient = (await db.query<{ id: number }>(`INSERT INTO patients(patient_number,full_name,primary_doctor_id)
    VALUES($1,'SYNTHETIC HTTP identity',$2) RETURNING id`, [`CASE-HTTP-${stamp}-${++identitySeq}`, doctor.party_id])).rows[0].id;
  const plan = (await db.query<{ id: number }>(`INSERT INTO treatment_plans(patient_id,title,total_minor,status,primary_doctor_id)
    VALUES($1,'SYNTHETIC',1,'active',$2) RETURNING id`, [patient, doctor.party_id])).rows[0].id;
  const service = (await db.query<{ id: number }>(`INSERT INTO services(name,category,price_minor)
    VALUES('SYNTHETIC RCT','rct',1) RETURNING id`)).rows[0].id;
  const item = (await db.query<{ id: number }>(`INSERT INTO plan_items(plan_id,service_id,service_name,category,tooth_code,unit_price_minor)
    VALUES($1,$2,'SYNTHETIC RCT','rct',36,1) RETURNING id`, [plan, service])).rows[0].id;
  const target = async (specialty = "endodontics", site: string | null = "36", owner = patient) =>
    (await db.query<{ id: number }>(`INSERT INTO clinical_cases(patient_id,specialty,title,site,created_by)
      VALUES($1,$2,'SYNTHETIC',$3,'synthetic') RETURNING id`, [owner, specialty, site])).rows[0].id;
  const put = (caseId: number | null, who: Who = "doctorA", priority = 3) =>
    authedMutation(`/api/plan-items/${item}/case`, h.sessions[who], "PUT", JSON.stringify({ caseId, priority }));
  const snapshot = async () => ({
    item: (await db.query(`SELECT * FROM plan_items WHERE id=$1`, [item])).rows,
    audit: (await db.query(`SELECT * FROM audit_log WHERE entity='patient' AND entity_id=$1 ORDER BY id`, [String(patient)])).rows,
    invoices: (await db.query(`SELECT * FROM invoices WHERE patient_id=$1`, [patient])).rows,
    payments: (await db.query(`SELECT * FROM payments WHERE patient_id=$1`, [patient])).rows,
  });
  return { patient, plan, service, item, target, put, snapshot };
}

describe("case identity validation on the built HTTP server", () => {
  it.each([
    ["prosthodontics", "36", "تخصص الحالة"],
    ["endodontics", "11", "موضع الحالة"],
    ["endodontics", null, "نطاق العلاج"],
  ] as const)("returns bounded Arabic 409 for %s / %s without writes", async (specialty, site, message) => {
    const f = await identityFixture(); const target = await f.target(specialty, site); const before = await f.snapshot();
    const response = await f.put(target);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: expect.stringContaining(message) });
    expect(await f.snapshot()).toEqual(before);
  });
  it("rejects stale closed candidates and keeps current closed historical priority editable", async () => {
    const f = await identityFixture(); const target = await f.target();
    // Candidate was read while active; closure commits before the submission.
    expect((await authedGet(`/api/patients/${f.patient}/cases`, h.sessions.doctorA)).status).toBe(200);
    const close = await authedMutation(`/api/cases/${target}`, h.sessions.doctorA, "PATCH", JSON.stringify({ status: "completed", outcome: "SYNTHETIC" }));
    expect(close.status).toBe(200);
    const before = await f.snapshot();
    expect((await f.put(target)).status).toBe(409);
    expect(await f.snapshot()).toEqual(before);
    await db.query(`UPDATE plan_items SET case_id=$2 WHERE id=$1`, [f.item, target]);
    expect((await f.put(target, "doctorA", 8)).status).toBe(200);
    expect((await f.snapshot()).item[0]).toMatchObject({ case_id: target, priority: 8 });
  });
  it("keeps draft relink/detach available while all role and patient fences remain authoritative", async () => {
    const f = await identityFixture(); const other = await identityFixture();
    const a = await f.target(); const b = await f.target(); const foreign = await other.target();
    for (const target of [a, b, null]) expect((await f.put(target)).status).toBe(200);
    const before = await f.snapshot();
    for (const who of ["reception", "cashier", "accountant", "doctorB"] as const) expect((await f.put(a, who)).status).toBe(403);
    for (const target of [foreign, 2147483647]) expect((await f.put(target)).status).toBe(400);
    expect(await f.snapshot()).toEqual(before);
  });
  it.each(["procedure", "session", "legacy_visit"] as const)("returns 409 for signed %s evidence and allows same-case priority", async evidence => {
    const f = await identityFixture(); const a = await f.target(); const b = await f.target();
    expect((await f.put(a)).status).toBe(200);
    const visit = (await db.query<{ id: number }>(`INSERT INTO visits(patient_id,patient_name)
      VALUES($1,'SYNTHETIC signed evidence') RETURNING id`, [f.patient])).rows[0].id;
    if (evidence === "procedure") await db.query(`INSERT INTO visit_procedures(visit_id,service_id,plan_item_id,tooth_code,unit_price_minor)
      VALUES($1,$2,$3,36,0)`, [visit, f.service, f.item]);
    if (evidence === "session") await db.query(`INSERT INTO treatment_sessions(plan_item_id,sequence,visit_id)
      VALUES($1,1,$2)`, [f.item, visit]);
    if (evidence === "legacy_visit") await db.query(`UPDATE plan_items SET visit_id=$2 WHERE id=$1`, [f.item, visit]);
    await db.query(`UPDATE visits SET signed_at=NOW(),signed_by='SYNTHETIC' WHERE id=$1`, [visit]);
    const before = await f.snapshot();
    for (const target of [b, null]) {
      const response = await f.put(target);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: expect.stringContaining("موقّع") });
    }
    expect(await f.snapshot()).toEqual(before);
    expect((await f.put(a, "doctorA", 7)).status).toBe(200);
    expect((await f.snapshot()).item[0]).toMatchObject({ case_id: a, priority: 7 });
  });
});
