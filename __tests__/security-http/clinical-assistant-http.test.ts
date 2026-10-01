import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness, loginStaff } from "./_server";

/**
 * (P0-F) المساعد السريري على التطبيق المبني: يُنهي زيارة اليوم التي وثّقها الطبيب **باسمه هو**
 * (signed_by)، والطبيب المعالج وطبيب سطر الفاتورة لا يتغيران؛ لا يعدّل إجراءً ولا سعرًا ولا طبيبًا؛
 * مرضى زيارات اليوم وحدهم؛ ولا مالية ولا إعدادات ولا أسعار — وكل رفضٍ بالعربية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let assistant: { cookie: string };
let doctorParty = 0;
let todayPatient = 0;
let otherPatient = 0;
let todayVisit = 0;
let oldVisit = 0;
let serviceId = 0;
const stamp = Date.now();
const username = `secassist${stamp}`.slice(0, 30);

const get = (path: string) => authedGet(path, assistant);
const post = (path: string, body: unknown) => authedMutation(path, assistant, "POST", JSON.stringify(body));

async function expectArabicDenied(response: Response) {
  expect([401, 403]).toContain(response.status);
  const body = await response.json().catch(() => ({})) as { message?: string };
  expect(body.message ?? "").toMatch(/[؀-ۿ]/);
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const created = await authedMutation("/api/users", h.sessions.admin, "POST", JSON.stringify({
    username, displayName: "مساعدة الكرسي", password: "Assist#Pass11", role: "assistant",
  }));
  expect(created.status).toBeLessThan(300);
  assistant = await loginStaff(username, "Assist#Pass11");

  doctorParty = (await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`)).rows[0].party_id;
  const patient = async (suffix: string) => (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`AST-${suffix}-${stamp}`, `مريض ${suffix}`])).rows[0].id;
  todayPatient = await patient("T");
  otherPatient = await patient("O");
  serviceId = (await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 25000, TRUE, TRUE, 'filling') RETURNING id`,
    [`حشوة مساعد ${stamp}`])).rows[0].id;
  todayVisit = (await db.query<{ id: number }>(
    `INSERT INTO visits (patient_id, patient_name, doctor_id, diagnosis) VALUES ($1, 'م', $2, 'تسوّس 16') RETURNING id`,
    [todayPatient, doctorParty])).rows[0].id;
  await db.query(`INSERT INTO visit_procedures (visit_id, service_id, doctor_id, tooth_code, quantity, unit_price_minor)
                  VALUES ($1, $2, $3, 16, 1, 25000)`, [todayVisit, serviceId, doctorParty]);
  oldVisit = (await db.query<{ id: number }>(
    `INSERT INTO visits (patient_id, patient_name, doctor_id, diagnosis, arrived_at) VALUES ($1, 'م', $2, 'قديمة', NOW() - INTERVAL '3 days') RETURNING id`,
    [otherPatient, doctorParty])).rows[0].id;
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("(P0-F) the clinical assistant finalizes today's visit under their own name", () => {
  it("reads today's visit, but not another patient's file or an old visit", async () => {
    expect((await get(`/api/visits/${todayVisit}/clinical`)).status).toBe(200);
    expect((await get(`/api/patients/${todayPatient}`)).status).toBe(200);
    await expectArabicDenied(await get(`/api/patients/${otherPatient}`));
    await expectArabicDenied(await get(`/api/visits/${oldVisit}/clinical`));
  });

  it("cannot change procedures, prices or the treating doctor", async () => {
    const line = { serviceId, toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 25000, doctorId: doctorParty, planItemId: null };
    await expectArabicDenied(await post(`/api/visits/${todayVisit}/clinical`, {
      action: "save", diagnosis: "تسوّس 16", doctorId: doctorParty, procedures: [{ ...line, unitPriceMinor: 1000 }],
    }));
    await expectArabicDenied(await post(`/api/visits/${todayVisit}/clinical`, {
      action: "save", diagnosis: "تسوّس 16", doctorId: doctorParty, procedures: [line, { ...line, toothCode: 17 }],
    }));
    await expectArabicDenied(await post(`/api/visits/${todayVisit}/clinical`, {
      action: "save", diagnosis: "تسوّس 16", doctorId: null, procedures: [line],
    }));
    /* إكمال الملاحظات مع الإجراءات كما هي ⇒ مقبول. */
    const notes = await post(`/api/visits/${todayVisit}/clinical`, {
      action: "save", diagnosis: "تسوّس 16", treatmentDone: "حشوة 16", doctorId: doctorParty, procedures: [line],
    });
    expect(notes.status).toBe(200);
  });

  it("cannot record an orthodontic adjustment with the sign; the patient header carries no plans, prices or appointments", async () => {
    const ortho = await post(`/api/visits/${todayVisit}/clinical`, {
      action: "sign", orthoSession: { caseId: 1, upperWire: "016 NiTi", lowerWire: null, elastics: "none", elasticNote: null, done: "شدّة", nextWeeks: 4 },
    });
    await expectArabicDenied(ortho);
    expect((await db.query(`SELECT signed_at FROM visits WHERE id = $1`, [todayVisit])).rows[0].signed_at).toBeNull();
    const workflow = await get(`/api/patients/${todayPatient}/workflow`);
    expect(workflow.status).toBe(200);
    expect(await workflow.json()).toMatchObject({ activePlans: [], plannedVisits: [], nextAppointment: null, financial: null });
  });

  it("signs: signed_by = assistant; treating doctor and invoice-line doctor unchanged; the finalizer is audited", async () => {
    const signed = await post(`/api/visits/${todayVisit}/clinical`, { action: "sign" });
    expect(signed.status).toBe(200);
    const { rows: [visit] } = await db.query<{ signed_by: string; doctor_id: number; invoice_id: number }>(
      `SELECT signed_by, doctor_id, invoice_id FROM visits WHERE id = $1`, [todayVisit]);
    expect(visit.signed_by).toBe(username);
    expect(visit.doctor_id).toBe(doctorParty);
    const { rows: lines } = await db.query<{ doctor_id: number }>(`SELECT doctor_id FROM invoice_items WHERE invoice_id = $1`, [visit.invoice_id]);
    expect(lines.map((one) => one.doctor_id)).toEqual([doctorParty]);
    const { rows: [audit] } = await db.query<{ actor: string; actor_role: string; details: Record<string, unknown> }>(
      `SELECT actor, actor_role, details FROM audit_log WHERE action = 'visit.sign' AND entity_id = $1`, [String(todayVisit)]);
    expect(audit).toMatchObject({ actor: username, actor_role: "assistant" });
    expect(audit.details).toMatchObject({ المنهي: username, دور_المنهي: "assistant", الطبيب_المعالج: doctorParty });
  });

  it("never reaches money, prices, settings, reports, plans or users", async () => {
    for (const path of [
      `/api/patients/${todayPatient}/ledger`, "/api/services", "/api/settings", "/api/finance/commissions",
      "/api/reports", "/api/plans", "/api/users", "/api/payments", "/api/invoices", "/api/parties",
    ]) {
      await expectArabicDenied(await get(path));
    }
    await expectArabicDenied(await authedMutation("/api/payments", assistant, "POST", JSON.stringify({})));
  });
});
