import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (VISIT-FLOW-1) شدّة تبويب التقويم تعيش في زيارة اليوم، وزيارة الشدّة تُوقَّع عند الطبيب — على PostgreSQL 18.
 *
 * ما كان يحدث: الطبيب يسجّل الشدّة من ملف التقويم (بلا زيارة)، فيخرج المريض إلى الاستقبال وزيارته فارغة،
 * ولا يُسمح بتوقيعها إلا بإجراءٍ مسعَّر أو تشخيصٍ يكتبه أحد.
 *
 * - شدّةٌ بتاريخ اليوم لمريضٍ له زيارةٌ غير موقّعة اليوم تُربط بها في الخادم.
 * - شدّةٌ بتاريخٍ سابق، أو لمريضٍ بلا زيارة اليوم، أو زيارته موقّعة: لا ربط (السلوك القديم).
 * - الزيارة التي فيها شدّةٌ فقط تُوقَّع: بلا فاتورة، وتُنهي الجلوس.
 * - الزيارة الفارغة حقًّا ما زالت تُرفض.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  ensureSchema, getPool, resetPoolForTesting, recordAdjustment, addVisit, signClinicalVisit, getClinicalVisit,
  CLINIC_TIME_ZONE,
} = await import("../../lib/db");
const { clinicDateString } = await import("../../lib/schedule");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
const count = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0].n;

const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
const yesterday = (() => {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
})();

let orthodontist = 0;

async function patientWithCase(number: string, name: string): Promise<{ patientId: number; caseId: number }> {
  const patientId = (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [number, name]))[0].id;
  const caseId = (await q<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, created_by, upper_wire, lower_wire) VALUES ($1, 'dr', '016 NiTi', '016 NiTi') RETURNING id`,
    [patientId]))[0].id;
  return { patientId, caseId };
}

async function openVisit(patientId: number, name: string, status: "waiting" | "in_chair" | "done" = "in_chair"): Promise<number> {
  const visit = await addVisit({ patientName: name, patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, status = $3 WHERE id = $1`, [visit.id, orthodontist, status]);
  return visit.id;
}

const fromOrthoTab = (caseId: number, doneOn: string) => ({
  caseId, visitId: null, doneOn, phase: null, upperWire: "017×025 NiTi", lowerWire: null,
  elastics: "class_ii" as const, elasticNote: null, done: "تبديل السلك العلوي", nextWeeks: 4, note: null,
  recordedBy: "dr-aqlan", actorRole: "doctor",
});

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  orthodontist = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. عقلان') RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(VISIT-FLOW-1) ortho-tab adjustment attaches to today's visit", () => {
  it("attaches to the patient's unsigned visit today, whatever its stage in the journey", async () => {
    for (const [index, status] of (["waiting", "in_chair", "done"] as const).entries()) {
      const { patientId, caseId } = await patientWithCase(`P-VF-A${index}`, `مريض ${status}`);
      const visitId = await openVisit(patientId, `مريض ${status}`, status);
      const result = await recordAdjustment(fromOrthoTab(caseId, today));
      if (!result.ok) throw new Error(result.message);
      expect(result).toMatchObject({ created: true, visitId, attachedToToday: true });
      expect(await q(`SELECT visit_id FROM ortho_adjustments WHERE id = $1`, [result.id])).toEqual([{ visit_id: visitId }]);
      expect((await getClinicalVisit(visitId))?.ortho?.visitAdjustmentId).toBe(result.id);
    }
  });

  it("a second save from the tab returns the same adjustment (one per case and visit)", async () => {
    const { patientId, caseId } = await patientWithCase("P-VF-B", "نقرة مزدوجة");
    const visitId = await openVisit(patientId, "نقرة مزدوجة");
    const [a, b] = await Promise.all([recordAdjustment(fromOrthoTab(caseId, today)), recordAdjustment(fromOrthoTab(caseId, today))]);
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(a.id).toBe(b.id);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments WHERE visit_id = $1`, [visitId])).toBe(1);
  });

  it("does not attach a back-dated entry, a patient without a visit today, or to a signed visit", async () => {
    const backdated = await patientWithCase("P-VF-C1", "إدخال متأخر");
    await openVisit(backdated.patientId, "إدخال متأخر");
    const late = await recordAdjustment(fromOrthoTab(backdated.caseId, yesterday));
    expect(late).toMatchObject({ ok: true, visitId: null, attachedToToday: false });

    const noVisit = await patientWithCase("P-VF-C2", "بلا زيارة");
    expect(await recordAdjustment(fromOrthoTab(noVisit.caseId, today)))
      .toMatchObject({ ok: true, visitId: null, attachedToToday: false });

    const signedOnly = await patientWithCase("P-VF-C3", "زيارة موقّعة");
    const visitId = await openVisit(signedOnly.patientId, "زيارة موقّعة");
    await q(`UPDATE visits SET signed_at = NOW(), signed_by = 'dr', status = 'done' WHERE id = $1`, [visitId]);
    expect(await recordAdjustment(fromOrthoTab(signedOnly.caseId, today)))
      .toMatchObject({ ok: true, visitId: null, attachedToToday: false });
    expect(await recordAdjustment({ ...fromOrthoTab(signedOnly.caseId, today), visitId }))
      .toMatchObject({ ok: false, message: "الزيارة موقّعة — لا يمكن إضافة شدّة إليها." });
  });

  it("rechecks the visit after a concurrent signer commits, leaving the signed visit unchanged", async () => {
    const { patientId, caseId } = await patientWithCase("P-VF-RACE", "توقيع متزامن");
    const visitId = await openVisit(patientId, "توقيع متزامن");
    const signer = await getPool().connect();
    try {
      await signer.query("BEGIN");
      await signer.query(`UPDATE visits SET signed_at = NOW(), signed_by = 'dr', status = 'done' WHERE id = $1`, [visitId]);
      const pending = recordAdjustment(fromOrthoTab(caseId, today));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await signer.query("COMMIT");
      expect(await pending).toMatchObject({ ok: true, visitId: null, attachedToToday: false });
      expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments WHERE visit_id = $1`, [visitId])).toBe(0);
    } finally {
      await signer.query("ROLLBACK").catch(() => {});
      signer.release();
    }
  });

  it("another patient's visit is never used", async () => {
    const mine = await patientWithCase("P-VF-D1", "صاحب الحالة");
    const other = await patientWithCase("P-VF-D2", "مريض آخر");
    await openVisit(other.patientId, "مريض آخر");
    expect(await recordAdjustment(fromOrthoTab(mine.caseId, today)))
      .toMatchObject({ ok: true, visitId: null, attachedToToday: false });
  });
});

describe("(VISIT-FLOW-1) a visit whose only content is the adjustment can be signed", () => {
  it("signs with no procedure and no diagnosis: no invoice, visit done, still one adjustment", async () => {
    const { patientId, caseId } = await patientWithCase("P-VF-E", "توقيع بالشدّة");
    const visitId = await openVisit(patientId, "توقيع بالشدّة");
    const saved = await recordAdjustment(fromOrthoTab(caseId, today));
    if (!saved.ok) throw new Error(saved.message);
    const invoicesBefore = await count(`SELECT COUNT(*)::int AS n FROM invoices`);

    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr-aqlan", signerRole: "doctor" });
    expect(signed.reason).toBeNull();
    expect(signed.invoiceId).toBeNull();
    expect(signed.duesMinor).toBe(0);
    expect(await count(`SELECT COUNT(*)::int AS n FROM invoices`)).toBe(invoicesBefore);
    expect(await q(`SELECT status, signed_by FROM visits WHERE id = $1`, [visitId]))
      .toEqual([{ status: "done", signed_by: "dr-aqlan" }]);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments WHERE visit_id = $1`, [visitId])).toBe(1);
  });

  it("a truly empty visit is still refused", async () => {
    const { patientId } = await patientWithCase("P-VF-F", "زيارة فارغة");
    const visitId = await openVisit(patientId, "زيارة فارغة");
    const result = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr-aqlan" });
    expect(result.reason).toBe("empty");
    expect(await q(`SELECT signed_at FROM visits WHERE id = $1`, [visitId])).toEqual([{ signed_at: null }]);
  });
});
