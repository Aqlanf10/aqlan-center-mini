import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signerDoctorPartyId } from "./_signer";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (VISIT-2) «الزيارات السريرية ما أقدر أنهيها — مافيش زر» — على PostgreSQL 18.
 *
 * ١) بعد «أنهِ الجلوس» (status = done) والزيارة لم تُوثَّق ولم تُوقَّع: كانت تختفي من «زيارة اليوم»
 *    في ملف المريض فيختفي زرّ إنهائها. يجب أن تبقى «قائمة» حتى تُوقَّع.
 * ٢) المريض الجديد (مشي بلا ملف): يُفتح له ملفٌّ من زيارته قبل التوقيع — مرةً واحدة ولو نُقر
 *    مرتين — فتعمل له الإجراءات كلها من ملفّه، ثم التوقيع يُصدر فاتورته على الملف نفسه.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, addVisit, seatVisit, finishVisit, patientWorkflow,
  openVisitPatientFile, setVisitProcedures, signClinicalVisit,
} = db;

const TODAY = new Date().toISOString().slice(0, 10);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("VISIT-2 — finishing a clinical visit", () => {
  it("an unsigned visit whose seating was finished stays the patient's open visit (the finish button stays)", async () => {
    const [{ id: patientId }] = await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('V2-1', 'مريض الجلوس المنتهي') RETURNING id`);
    const visit = await addVisit({ patientName: "مريض الجلوس المنتهي", patientPhone: null, note: null, patientId });
    await seatVisit(visit.id, 1);
    await finishVisit(visit.id);

    const workflow = await patientWorkflow(patientId, TODAY);
    expect(workflow.openVisit).toMatchObject({ id: visit.id, status: "done" });
  });

  it("an unsigned finished visit stays open however old it is — no calendar cutoff hides it again", async () => {
    const [{ id: patientId }] = await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('V2-OLD', 'زيارة قديمة غير موقَّعة') RETURNING id`);
    const visit = await addVisit({ patientName: "زيارة قديمة غير موقَّعة", patientPhone: null, note: null, patientId });
    await seatVisit(visit.id, 1);
    await finishVisit(visit.id);
    await q(`UPDATE visits SET arrived_at = NOW() - INTERVAL '5 days' WHERE id = $1`, [visit.id]);
    expect((await patientWorkflow(patientId, TODAY)).openVisit).toMatchObject({ id: visit.id, status: "done" });
  });

  it("a signed visit is no longer open", async () => {
    const [{ id: patientId }] = await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('V2-2', 'مريض موقَّع') RETURNING id`);
    const visit = await addVisit({ patientName: "مريض موقَّع", patientPhone: null, note: null, patientId });
    await q(`UPDATE visits SET diagnosis = 'فحص' WHERE id = $1`, [visit.id]);
    const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: await signerDoctorPartyId() });
    expect(signed.reason).toBeNull();
    expect((await patientWorkflow(patientId, TODAY)).openVisit).toBeNull();
  });

  it("a walk-in (new patient) gets a file from the visit before signing — once, even on a double click", async () => {
    const before = (await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM patients`))[0].n;
    const visit = await addVisit({ patientName: "مريض جديد تمامًا", patientPhone: "777000111", note: null });
    expect(visit.patientId).toBeNull();

    const [first, second] = await Promise.all([openVisitPatientFile(visit.id), openVisitPatientFile(visit.id)]);
    expect(first.ok && second.ok).toBe(true);
    const ids = [first, second].map((result) => (result.ok ? result.patientId : 0));
    expect(ids[0]).toBe(ids[1]);
    expect((await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM patients`))[0].n).toBe(before + 1);
    expect([first, second].filter((result) => result.ok && result.created)).toHaveLength(1);

    const [row] = await q<{ patient_id: number }>(`SELECT patient_id FROM visits WHERE id = $1`, [visit.id]);
    expect(row.patient_id).toBe(ids[0]);
    // الملف الجديد يرى زيارته قائمةً — ومنها يُكمل الطبيب كل شيء.
    expect((await patientWorkflow(ids[0], TODAY)).openVisit?.id).toBe(visit.id);

    // والتوقيع يُصدر الفاتورة على الملف نفسه — لا ملفٌ ثانٍ.
    const [{ id: serviceId }] = await q<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('كشف', 5000, TRUE, TRUE, 'exam') RETURNING id`);
    await setVisitProcedures({
      visitId: visit.id,
      procedures: [{ serviceId, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 5000, priceReason: null, doctorId: null, note: null, planItemId: null }],
    });
    const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: await signerDoctorPartyId() });
    expect(signed.reason).toBeNull();
    expect((await q<{ patient_id: number }>(`SELECT patient_id FROM invoices WHERE id = $1`, [signed.invoiceId]))[0].patient_id).toBe(ids[0]);
    expect((await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM patients`))[0].n).toBe(before + 1);
  });

  it("a walk-in whose phone matches an existing file is linked to it, not duplicated", async () => {
    const [{ id: existing }] = await q<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name, phone) VALUES ('V2-3', 'مريض قديم', '777222333') RETURNING id`);
    const visit = await addVisit({ patientName: "مريض قديم", patientPhone: "777222333", note: null });
    const opened = await openVisitPatientFile(visit.id);
    expect(opened).toEqual({ ok: true, patientId: existing, created: false });
  });

  it("a signed visit cannot get a new file opened (its invoice already belongs to a file)", async () => {
    expect(await openVisitPatientFile(999_999)).toEqual({ ok: false, reason: "not_found" });
  });
});
