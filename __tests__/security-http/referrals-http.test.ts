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
const stamp = Date.now();

const draft = {
  toName: "د. سامي — جراحة الفكين", toSpecialty: "oral_surgery",
  reason: "قلع الضواحك الأولى الأربعة قبل بدء التقويم", teeth: "14، 24، 34، 44", urgency: "soon",
};

function create(session: "admin" | "reception" | "doctorA" | "doctorB", body: unknown = draft) {
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
});
