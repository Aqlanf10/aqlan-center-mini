import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (ENDO-2) علاج الجذور على التطبيق المبني: من يقرأ، من يكتب، من لا يرى مريض غيره، التجميد بالتوقيع،
 * والتكرار/التزامن — كل رفضٍ برسالة عربية بلا تفاصيل داخلية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let caseId = 0;
let doctorPartyId = 0;
let treatmentId = 0;
let visitId = 0;
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const send = (who: Who, method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) =>
  authedMutation(path, h.sessions[who], method, body === undefined ? undefined : JSON.stringify(body));
const messageOf = async (response: Response) => (await response.json() as { message?: string }).message ?? "";
const base = () => `/api/patients/${patientId}/endo`;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  doctorPartyId = doctor.party_id;
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض العصب', $2) RETURNING id`,
    [`EN-${stamp}`, doctorPartyId]);
  patientId = patient.id;
  const created = await send("doctorA", "POST", `/api/patients/${patientId}/cases`, { specialty: "endodontics", title: "علاج عصب — ٣٦", site: "36" });
  caseId = (await created.json() as { id: number }).id;
  const { rows: [visit] } = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ('مريض العصب', $1, $2) RETURNING id`, [patientId, doctorPartyId]);
  visitId = visit.id;
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("ENDO-2 — permissions", () => {
  it("reception reads but cannot open a treatment (Arabic 403); cashier/accountant are outside entirely", async () => {
    expect((await authedGet(base(), h.sessions.reception)).status).toBe(200);
    const denied = await send("reception", "POST", base(), { toothCode: 36, caseId });
    expect(denied.status).toBe(403);
    expect(await messageOf(denied)).toContain("يكتبها الطبيب");
    for (const who of ["cashier", "accountant"] as const) {
      const response = await authedGet(base(), h.sessions[who]);
      expect(response.status).toBe(403);
      expect(await messageOf(response)).toMatch(/[؀-ۿ]/);
    }
  });

  it("a doctor who does not own the patient can neither read nor write", async () => {
    expect((await authedGet(base(), h.sessions.doctorB)).status).toBe(403);
    expect((await send("doctorB", "POST", base(), { toothCode: 36, caseId })).status).toBe(403);
  });
});

describe("ENDO-2 — workflow over HTTP", () => {
  it("opens a treatment; validation and duplicates are Arabic 4xx", async () => {
    const bad = await send("doctorA", "POST", base(), { toothCode: 19, caseId });
    expect(bad.status).toBe(400);
    expect(await messageOf(bad)).toBe("اختر السن (ترقيم FDI).");
    const wrongCase = await send("doctorA", "POST", base(), { toothCode: 36, caseId: 999999 });
    expect(wrongCase.status).toBe(400);

    const created = await send("doctorA", "POST", base(), { toothCode: 36, caseId });
    expect(created.status).toBe(201);
    treatmentId = (await created.json() as { id: number }).id;
    const dup = await send("doctorA", "POST", base(), { toothCode: 36, caseId });
    expect(dup.status).toBe(409);
    expect(await messageOf(dup)).toContain("علاج جذورٍ جارٍ");
  });

  it("saves a visit record with canals; retry is idempotent; stale version and different content are 409s", async () => {
    const path = `${base()}/${treatmentId}/visits`;
    const body = {
      visitId, stage: "assessment", pulpalDiagnosis: "pulp_necrosis", apicalDiagnosis: "chronic_apical_abscess", canalsFound: 3,
      canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both" }, { label: "ML" }, { label: "D" }],
    };
    const first = await send("doctorA", "PUT", path, body);
    expect(first.status).toBe(201);
    const view = await first.json() as { visits: { id: number; version: number; doctorId: number }[]; nextAction: string };
    expect(view.visits[0]).toMatchObject({ version: 1, doctorId: doctorPartyId });
    expect(view.nextAction).toMatch(/[؀-ۿ]/);

    expect((await send("doctorA", "PUT", path, body)).status).toBe(200); // lost-response retry
    const different = await send("doctorA", "PUT", path, { ...body, note: "آخر" });
    expect(different.status).toBe(409);
    expect(await messageOf(different)).toContain("حمّله وعدّله");
    const stale = await send("doctorA", "PUT", path, { ...body, note: "آخر", expectedVersion: 7 });
    expect(stale.status).toBe(409);
    expect(await messageOf(stale)).toContain("عدّل هذا السجل شخصٌ آخر");
    expect((await send("doctorA", "PUT", path, { ...body, note: "محدَّث", expectedVersion: 1 })).status).toBe(200);

    const badWl = await send("doctorA", "PUT", path, { ...body, canals: [{ label: "MB", workingLengthMm: 99, referencePoint: "cusp_tip", measurementMethod: "both" }] });
    expect(badWl.status).toBe(400);
    expect(await messageOf(badWl)).toContain("الطول العامل");
    expect((await send("reception", "PUT", path, body)).status).toBe(403);
    expect((await send("doctorB", "PUT", path, body)).status).toBe(403);
  });

  it("another patient's treatment id in the URL is a 404 (isolation) and a foreign visit is refused", async () => {
    const { rows: [other] } = await db.query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض آخر', $2) RETURNING id`, [`EN2-${stamp}`, doctorPartyId]);
    const foreign = await send("doctorA", "PUT", `/api/patients/${other.id}/endo/${treatmentId}/visits`, { visitId, stage: "review" });
    expect(foreign.status).toBe(404);
    const { rows: [otherVisit] } = await db.query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ('x', $1, $2) RETURNING id`, [other.id, doctorPartyId]);
    const wrong = await send("doctorA", "PUT", `${base()}/${treatmentId}/visits`, { visitId: otherVisit.id, stage: "review" });
    expect(wrong.status).toBe(400);
  });

  it("after sign-off the record is frozen; the addendum appends and is audited", async () => {
    await db.query(`UPDATE visits SET signed_at = NOW(), signed_by = 'doctor' WHERE id = $1`, [visitId]);
    const frozen = await send("doctorA", "PUT", `${base()}/${treatmentId}/visits`, { visitId, stage: "assessment", note: "تعديل صامت", expectedVersion: 2 });
    expect(frozen.status).toBe(409);
    expect(await messageOf(frozen)).toContain("بملحق");

    const list = await (await authedGet(base(), h.sessions.reception)).json() as { treatments: { visits: { id: number; note: string }[] }[] };
    const endoVisitId = list.treatments[0].visits[0].id;
    expect(list.treatments[0].visits[0].note).toBe("محدَّث");

    const addendumPath = `${base()}/${treatmentId}/visits/${endoVisitId}/addenda`;
    expect((await send("reception", "POST", addendumPath, { requestKey: "http:addendum-key", text: "x" })).status).toBe(403);
    expect((await send("doctorA", "POST", addendumPath, { requestKey: "http:addendum-key", text: "  " })).status).toBe(400);
    const added = await send("doctorA", "POST", addendumPath, { requestKey: "http:addendum-key", text: "تصحيح: القناة D طولها ٢١٫٥" });
    expect(added.status).toBe(201);
    const after = await added.json() as { visits: { addenda: { body: string; author: string }[] }[] };
    expect(after.visits[0].addenda[0]).toMatchObject({ body: "تصحيح: القناة D طولها ٢١٫٥", author: "secdoctora" });

    expect((await send("doctorA", "POST", addendumPath, { requestKey: "http:addendum-key", text: "تصحيح: القناة D طولها ٢١٫٥" })).status).toBe(200);
    expect((await send("doctorA", "POST", addendumPath, { requestKey: "http:addendum-key", text: "changed payload" })).status).toBe(409);
    expect((await send("doctorA", "POST", addendumPath, { text: "missing key" })).status).toBe(400);
    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'endo.%' ORDER BY id`, [String(patientId)]);
    expect(rows.map((row) => row.action)).toEqual(["endo.open", "endo.visit_save", "endo.visit_save", "endo.addendum"]);
  });

  it("completion and abandon rules over HTTP", async () => {
    const path = `${base()}/${treatmentId}`;
    const noReason = await send("doctorA", "PATCH", path, { status: "abandoned" });
    expect(noReason.status).toBe(400);
    const notReady = await send("doctorA", "PATCH", path, { status: "completed" });
    expect(notReady.status).toBe(409);
    expect(await messageOf(notReady)).toMatch(/[؀-ۿ]/);
    expect((await send("reception", "PATCH", path, { status: "abandoned", outcome: "x" })).status).toBe(403);
    expect((await send("doctorA", "PATCH", path, { status: "abandoned", outcome: "المريض لم يعد" })).status).toBe(200);
    expect((await send("doctorA", "PATCH", path, { status: "completed" })).status).toBe(409);
  });

  it("crown decision needs a boolean and respects plan-edit permission when it touches the plan", async () => {
    const { rows: [t] } = await db.query<{ id: number }>(
      `INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 46, 'admin') RETURNING id`, [patientId, caseId]);
    const path = `${base()}/${t.id}/crown`;
    expect((await send("doctorA", "PATCH", path, {})).status).toBe(400);
    expect((await send("reception", "PATCH", path, { crownRequired: true })).status).toBe(403);
    const ok = await send("doctorA", "PATCH", path, { crownRequired: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ crownRequired: true, crown: "waiting_rct" });
    const bad = await send("doctorA", "PATCH", path, { crownRequired: true, crownPlanItemId: 999999 });
    expect(bad.status).toBe(400);
  });
  it("revoked plan rights redact linked crown details and prevent unlinking via null IDs", async () => {
    const { rows:[t] }=await db.query<{id:number}>(`SELECT id FROM endo_treatments WHERE patient_id=$1 AND tooth_code=46`,[patientId]);
    const { rows:[plan] }=await db.query<{id:number}>(`INSERT INTO treatment_plans(patient_id,title,total_minor,status) VALUES($1,'synthetic',2,'active') RETURNING id`,[patientId]);
    const { rows:[crown] }=await db.query<{id:number}>(`INSERT INTO plan_items(plan_id,service_name,category,tooth_code,unit_price_minor,status) VALUES($1,'PRIVATE ENDO CROWN','crown',46,1,'done') RETURNING id`,[plan.id]);
    const { rows:[rct] }=await db.query<{id:number}>(`INSERT INTO plan_items(plan_id,service_name,category,tooth_code,case_id,unit_price_minor) VALUES($1,'RCT','rct',46,$2,1) RETURNING id`,[plan.id,caseId]);
    expect((await send("doctorA","PATCH",`${base()}/${t.id}/crown`,{crownRequired:true,crownPlanItemId:crown.id,rctPlanItemId:rct.id})).status).toBe(200);
    const { rows:[user] }=await db.query<{permissions:string|null}>(`SELECT permissions FROM users WHERE username='secdoctora'`);
    const permissions={...JSON.parse(user.permissions??"{}"),canViewPlans:false,canEditPlans:false};
    await db.query(`UPDATE users SET permissions=$1 WHERE username='secdoctora'`,[JSON.stringify(permissions)]);
    try {
      const response=await authedGet(base(),h.sessions.doctorA); const text=await response.text();
      expect(response.status).toBe(200); expect(text).not.toContain("PRIVATE ENDO CROWN");
      const view=JSON.parse(text) as {treatments:{id:number;crownPlanItem:unknown;crown:string}[]};
      expect(view.treatments.find(row=>row.id===t.id)).toMatchObject({crownPlanItem:null,crown:"waiting_rct"});
      expect((await send("doctorA","PATCH",`${base()}/${t.id}/crown`,{crownRequired:false,crownPlanItemId:null,rctPlanItemId:null})).status).toBe(403);
      const changed=await send("doctorA","PATCH",`${base()}/${t.id}`,{status:"abandoned",outcome:"synthetic"});
      expect(changed.status).toBe(200); expect(await changed.text()).not.toContain("PRIVATE ENDO CROWN");
    } finally {await db.query(`UPDATE users SET permissions=$1 WHERE username='secdoctora'`,[user.permissions]);}
  });

});


describe("Endo canonical tooth boundary over HTTP", () => {
  it.each(["11", null] as const)("rejects a selected case with site %s before episode or audit insertion", async site => {
    const created = await send("doctorA", "POST", `/api/patients/${patientId}/cases`, {
      specialty: "endodontics", title: "SYNTHETIC scope boundary", site,
    });
    expect(created.status).toBe(201);
    const target = (await created.json() as { id: number }).id;
    const snapshot = async () => ({
      treatments: (await db.query(`SELECT * FROM endo_treatments WHERE patient_id=$1 ORDER BY id`, [patientId])).rows,
      audit: (await db.query(`SELECT * FROM audit_log WHERE entity='patient' AND entity_id=$1 ORDER BY id`, [String(patientId)])).rows,
      invoices: (await db.query(`SELECT * FROM invoices WHERE patient_id=$1 ORDER BY id`, [patientId])).rows,
      payments: (await db.query(`SELECT * FROM payments WHERE patient_id=$1 ORDER BY id`, [patientId])).rows,
    });
    const before = await snapshot();
    const response = await send("doctorA", "POST", base(), { toothCode: 47, caseId: target });
    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["message"]);
    expect(body.message).toBe(site === null
      ? "موضع الحالة غير محدّد؛ راجع نطاقها السريري قبل فتح نوبة جديدة."
      : "موضع الحالة لا يطابق سن نوبة علاج الجذور.");
    expect(await snapshot()).toEqual(before);
  });
});
