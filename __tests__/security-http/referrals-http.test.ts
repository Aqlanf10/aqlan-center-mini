import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (P3-8) الإحالات الصادرة على التطبيق المبني: من يصدر الخطاب، ومن يسجّل النتيجة،
 * ومن لا يرى مريض غيره.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let referralId = 0;
let internalId = 0;
let sourceCaseId = 0;
let receivingDoctorId = 0;
let wrongCaseId = 0;
let labId = 0;
const stamp = Date.now();

const draft = {
  toName: "د. سامي — جراحة الفكين", toSpecialty: "oral_surgery",
  reason: "قلع الضواحك الأولى الأربعة قبل بدء التقويم", teeth: "14، 24، 34، 44", urgency: "soon",
};

function create(session: "admin" | "reception" | "doctorA" | "doctorB" | "accountant" | "cashier", body: unknown = draft) {
  return authedMutation(`/api/patients/${patientId}/referrals`, h.sessions[session], "POST", JSON.stringify(body));
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const { rows: [row] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id, medical_alert)
     VALUES ($1, 'مريض الإحالة', $2, 'حساسية بنسلين') RETURNING id`,
    [`RF-${stamp}`, doctor.party_id],
  );
  patientId = row.id;
  receivingDoctorId = (await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctorb'`)).rows[0].party_id;
  sourceCaseId = (await db.query<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, created_by)
     VALUES ($1, 'orthodontics', 'تقويم ٢١', 'test') RETURNING id`, [patientId])).rows[0].id;
  wrongCaseId = (await db.query<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, created_by)
     VALUES ($1, 'orthodontics', 'حالة مريض آخر', 'test') RETURNING id`, [h.seeded.patientBId])).rows[0].id;
  labId = (await db.query<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('lab', 'مختبر اختبار') RETURNING id`)).rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.end();
});

describe("P3-8 — الإحالات الصادرة", () => {
  it("الاستقبال لا يصدر خطاب إحالة", async () => {
    const response = await create("reception");
    expect(response.status).toBe(403);
    expect((await response.json() as { message: string }).message).toContain("الطبيب المعالج");
  });

  it("طبيبٌ لا يملك المريض لا يحيله", async () => {
    expect((await create("doctorB")).status).toBe(403);
  });

  it("رقم سنٍّ غير صالح يُرفض برسالة عربية", async () => {
    const response = await create("doctorA", { ...draft, teeth: "14 99" });
    expect(response.status).toBe(400);
    expect((await response.json() as { message: string }).message).toContain("FDI");
  });

  it("طبيب المريض يصدرها: تُحفظ مفتوحة بأسنانٍ مطبَّعة", async () => {
    const response = await create("doctorA");
    expect(response.status).toBe(201);
    const body = await response.json() as { id: number; status: string; teeth: string; doctorName: string | null };
    expect(body).toMatchObject({ status: "sent", teeth: "14, 24, 34, 44" });
    expect(body.doctorName).toBeTruthy();
    referralId = body.id;
  });

  it("الخطاب يُطبع للطبيب بالتنبيه الطبي والأسنان، ولا يُطبع للاستقبال", async () => {
    const page = await authedGet(`/print/referral/${referralId}`, h.sessions.doctorA);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("خطاب إحالة");
    expect(html).toContain("حساسية بنسلين");
    expect(html).toContain("14, 24, 34, 44");
    expect((await authedGet(`/print/referral/${referralId}`, h.sessions.reception)).status).toBe(404);
  });

  it("الاستقبال يسجّل النتيجة مرة واحدة — والثانية 409", async () => {
    const done = await authedMutation(`/api/referrals/${referralId}`, h.sessions.reception, "PATCH",
      JSON.stringify({ action: "complete", note: "قُلعت الأربعة" }));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: "completed", outcomeNote: "قُلعت الأربعة" });
    const again = await authedMutation(`/api/referrals/${referralId}`, h.sessions.reception, "PATCH",
      JSON.stringify({ action: "cancel", note: "خطأ" }));
    expect(again.status).toBe(409);
  });

  it("الطبيب الآخر لا يرى إحالات مريضٍ ليس له", async () => {
    expect((await authedGet(`/api/patients/${patientId}/referrals`, h.sessions.doctorB)).status).toBe(403);
    const own = await authedGet(`/api/patients/${patientId}/referrals`, h.sessions.doctorA);
    expect(own.status).toBe(200);
    expect(await own.json()).toHaveLength(1);
  });

  const internal = () => ({ kind: "internal", toSpecialty: "endodontics", reason: "علاج عصب قبل متابعة التقويم",
    teeth: "21", urgency: "soon", sourceCaseId, targetCaseId: null, toPartyId: receivingDoctorId,
    clinicalNotes: "راجع الأشعة", requestKey: "123e4567-e89b-42d3-a456-426614174099" });

  it("الطبيب المُحيل ينشئ إحالة داخلية للمريض نفسه وطبيب مختلف، والتكرار يعيد السجل نفسه", async () => {
    const first = await create("doctorA", internal());
    expect(first.status).toBe(201);
    const body = await first.json() as { id: number; kind: string; sourceCaseId: number; toPartyId: number; workflowState: string };
    expect(body).toMatchObject({ kind: "internal", sourceCaseId, toPartyId: receivingDoctorId, workflowState: "sent" });
    internalId = body.id;
    const repeated = await create("doctorA", internal());
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as { id: number }).id).toBe(internalId);
  });

  it("الاستقبال يقرأ سياق الإحالة الداخلية ولا يغيّر القرار السريري، والمحاسب لا ينشئها", async () => {
    const read = await authedGet(`/api/patients/${patientId}/referrals`, h.sessions.reception);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: internalId, sourceCaseTitle: "تقويم ٢١" })]));
    const change = await authedMutation(`/api/referrals/${internalId}`, h.sessions.reception, "PATCH",
      JSON.stringify({ action: "complete", note: "نتيجة مزيفة" }));
    expect(change.status).toBe(409);
    expect((await create("reception", { ...internal(), requestKey: "123e4567-e89b-42d3-a456-426614174100" })).status).toBe(403);
    expect((await create("accountant", { ...internal(), requestKey: "123e4567-e89b-42d3-a456-426614174101" })).status).toBe(403);
    expect((await create("cashier", { ...internal(), requestKey: "123e4567-e89b-42d3-a456-426614174102" })).status).toBe(403);
  });

  it("يرفض حالة مريض آخر، وجهة مختبر، ووصول طبيب غير مخوّل", async () => {
    expect((await create("doctorA", { ...internal(), requestKey: "123e4567-e89b-42d3-a456-426614174103", sourceCaseId: wrongCaseId })).status).toBe(400);
    expect((await create("doctorA", { ...internal(), requestKey: "123e4567-e89b-42d3-a456-426614174104", toPartyId: labId })).status).toBe(400);
    expect((await create("doctorB", { ...internal(), requestKey: "123e4567-e89b-42d3-a456-426614174105" })).status).toBe(403);
    expect((await authedGet(`/api/patients/${patientId}/referrals`, h.sessions.doctorB)).status).toBe(403);
    expect((await authedGet(`/print/referral/${internalId}`, h.sessions.doctorA)).status).toBe(404);
  });
});
