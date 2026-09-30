import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (CASE-1) الحالة التقويمية السابقة (قبل النظام) وشدّة التقويم داخل توقيع الزيارة — على PostgreSQL 18.
 *
 * - اللقطة السابقة: صفّ حالةٍ واحد مدقَّق، بلا فاتورة ولا زيارة ولا حركة مال.
 * - الشدّة مرةً واحدة لكل (حالة، زيارة): نقرة مزدوجة، إعادة محاولة، توقيعان متزامنان، أو شدّة من التبويب ثم التوقيع.
 * - تقرير المكررات للقراءة فقط.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, recordOrthoBaseline, recordAdjustment, addVisit,
  signClinicalVisit, getClinicalVisit, getOrthoCase, listPatientCases, listOrthoDuplicateAdjustments,
} = db;
const { buildReport, parseFilters } = await import("../../lib/reports");
const { checkBaselineDraft } = await import("../../lib/ortho-baseline");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
const count = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0].n;

const TODAY = "2026-09-30";
let orthodontist = 0;
let legacyPatient = 0;
let otherPatient = 0;
let legacyCase = 0;
let otherCase = 0;

const baselineBody = { phase: "working", financialMode: "installments", monthsElapsed: 10, monthsRemaining: 8,
  upperWire: "019×025 SS", lowerWire: "017×025 NiTi", elastics: "صنف ثانٍ 3/16 ليلًا",
  remainingObjectives: "إغلاق فراغ القلع العلوي" };

async function openVisit(patientId: number, name: string): Promise<number> {
  const visit = await addVisit({ patientName: name, patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, diagnosis = 'متابعة تقويم' WHERE id = $1`, [visit.id, orthodontist]);
  return visit.id;
}

const session = (caseId: number) => ({
  caseId, phase: null, upperWire: "019×025 TMA", lowerWire: null, elastics: "class_ii" as const,
  elasticNote: null, done: "تبديل السلك العلوي", nextWeeks: 5, note: null,
});

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  orthodontist = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. عقلان') RETURNING id`))[0].id;
  legacyPatient = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('P-ORTHO-1', 'سارة علي') RETURNING id`))[0].id;
  otherPatient = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('P-ORTHO-2', 'مريض آخر') RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(CASE-1) legacy orthodontic baseline", () => {
  it("records one audited legacy case — no invoice, no visit, no adjustment, no payment", async () => {
    const draft = checkBaselineDraft(baselineBody, TODAY);
    if (!draft.ok) throw new Error(draft.message);
    const before = {
      invoices: await count(`SELECT COUNT(*)::int AS n FROM invoices`),
      visits: await count(`SELECT COUNT(*)::int AS n FROM visits`),
      payments: await count(`SELECT COUNT(*)::int AS n FROM payments`),
      adjustments: await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments`),
    };
    const result = await recordOrthoBaseline({
      ...draft.value, responsibleDoctorId: orthodontist, patientId: legacyPatient, actor: "dr-aqlan", actorRole: "doctor",
    });
    if (!result.ok) throw new Error(result.reason);
    legacyCase = result.id;

    expect({
      invoices: await count(`SELECT COUNT(*)::int AS n FROM invoices`),
      visits: await count(`SELECT COUNT(*)::int AS n FROM visits`),
      payments: await count(`SELECT COUNT(*)::int AS n FROM payments`),
      adjustments: await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments`),
    }).toEqual(before);

    const found = await getOrthoCase(legacyCase, TODAY);
    expect(found).toMatchObject({
      baselineKind: "legacy", status: "active", phase: "working", startDate: "2025-11-30", plannedMonths: 18,
      upperWire: "019×025 SS", lowerWire: "017×025 NiTi", elastics: "صنف ثانٍ 3/16 ليلًا",
      responsibleDoctorId: orthodontist, responsibleDoctorName: "د. عقلان",
      legacyFinancialMode: "installments", remainingObjectives: "إغلاق فراغ القلع العلوي",
    });
    expect(found?.baselineRecordedAt).not.toBeNull();
    expect(found?.progress.monthsElapsed).toBeGreaterThanOrEqual(10);

    const audit = await q<{ action: string; actor: string; actor_role: string; entity_id: string }>(
      `SELECT action, actor, actor_role, entity_id FROM audit_log WHERE action = 'ortho.baseline'`);
    expect(audit).toEqual([{ action: "ortho.baseline", actor: "dr-aqlan", actor_role: "doctor", entity_id: String(legacyPatient) }]);
  });

  it("the unified case list names the baseline's responsible doctor (no plan needed)", async () => {
    const cases = await listPatientCases(legacyPatient);
    expect(cases).toEqual([expect.objectContaining({ kind: "ortho", orthoCaseId: legacyCase, responsiblePartyId: orthodontist, responsibleName: "د. عقلان" })]);
  });

  it("refuses a second open case, a non-doctor responsible, a foreign plan — writing nothing", async () => {
    const draft = checkBaselineDraft(baselineBody, TODAY);
    if (!draft.ok) throw new Error(draft.message);
    const cases = await count(`SELECT COUNT(*)::int AS n FROM ortho_cases`);
    const audits = await count(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ortho.baseline'`);
    expect(await recordOrthoBaseline({ ...draft.value, patientId: legacyPatient, actor: "dr" })).toEqual({ ok: false, reason: "open_case" });
    const lab = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('lab', 'معمل') RETURNING id`))[0].id;
    expect(await recordOrthoBaseline({ ...draft.value, responsibleDoctorId: lab, patientId: otherPatient, actor: "dr" })).toEqual({ ok: false, reason: "bad_doctor" });
    const plan = (await q<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status) VALUES ($1, 'خطة', 0, 'YER', 'active') RETURNING id`, [legacyPatient]))[0].id;
    expect(await recordOrthoBaseline({ ...draft.value, planId: plan, patientId: otherPatient, actor: "dr" })).toEqual({ ok: false, reason: "bad_plan" });
    expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_cases`)).toBe(cases);
    expect(await count(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ortho.baseline'`)).toBe(audits);
  });

  it("the database rejects an unknown financial mode or baseline kind", async () => {
    await expect(q(`UPDATE ortho_cases SET legacy_financial_mode = 'free' WHERE id = $1`, [legacyCase])).rejects.toThrow();
    await expect(q(`UPDATE ortho_cases SET baseline_kind = 'imported' WHERE id = $1`, [legacyCase])).rejects.toThrow();
  });
});

describe("(CASE-1) one orthodontic session per visit", () => {
  it("the sign writes the adjustment inside its transaction; the visit shows it; a retry adds nothing", async () => {
    const visitId = await openVisit(legacyPatient, "سارة علي");
    const invoicesBefore = await count(`SELECT COUNT(*)::int AS n FROM invoices`);
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr-aqlan", orthoSession: session(legacyCase), signerRole: "doctor" });
    expect(signed.reason).toBeNull();
    expect(signed.orthoAdjustmentId).not.toBeNull();
    const rows = await q<{ id: number; upper_wire: string; lower_wire: string; elastics: string; next_weeks: number; recorded_by: string }>(
      `SELECT id, upper_wire, lower_wire, elastics, next_weeks, recorded_by FROM ortho_adjustments WHERE case_id = $1 AND visit_id = $2`, [legacyCase, visitId]);
    expect(rows).toEqual([{ id: signed.orthoAdjustmentId, upper_wire: "019×025 TMA", lower_wire: "017×025 NiTi", elastics: "class_ii", next_weeks: 5, recorded_by: "dr-aqlan" }]);
    // سلك الحالة تحدّث في المعاملة نفسها؛ والسفلي الفارغ «بلا تغيير».
    expect(await q(`SELECT upper_wire, lower_wire FROM ortho_cases WHERE id = $1`, [legacyCase]))
      .toEqual([{ upper_wire: "019×025 TMA", lower_wire: "017×025 NiTi" }]);
    // حالة «أقساط» سابقة: التوقيع بلا إجراءات لا يُصدر فاتورة.
    expect(await count(`SELECT COUNT(*)::int AS n FROM invoices`)).toBe(invoicesBefore);
    expect((await getClinicalVisit(visitId))?.ortho?.visitAdjustmentId).toBe(signed.orthoAdjustmentId);
    expect(await count(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ortho.adjustment' AND details->>'المصدر' = 'توقيع الزيارة'`)).toBe(1);

    const retry = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr-aqlan", orthoSession: session(legacyCase) });
    expect(retry.reason).toBe("already_signed");
    expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments WHERE visit_id = $1`, [visitId])).toBe(1);
  });

  it("a double-clicked concurrent sign produces one signature and one adjustment", async () => {
    const visitId = await openVisit(legacyPatient, "سارة علي");
    const [a, b] = await Promise.all([
      signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr-aqlan", orthoSession: session(legacyCase) }),
      signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr-aqlan", orthoSession: session(legacyCase) }),
    ]);
    expect([a.reason, b.reason].sort()).toEqual(["already_signed", null].sort());
    expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments WHERE visit_id = $1`, [visitId])).toBe(1);
  });

  it("the existing API is idempotent per (case, visit): double click and concurrency return the same row", async () => {
    const visitId = await openVisit(legacyPatient, "سارة علي");
    const input = {
      caseId: legacyCase, visitId, doneOn: TODAY, phase: null, upperWire: null, lowerWire: null,
      elastics: "none" as const, elasticNote: null, done: "شدّ", nextWeeks: 4, note: null, recordedBy: "dr-aqlan",
    };
    const first = await recordAdjustment(input);
    const again = await recordAdjustment(input);
    const [c1, c2] = await Promise.all([recordAdjustment(input), recordAdjustment(input)]);
    if (!first.ok || !again.ok || !c1.ok || !c2.ok) throw new Error("refused");
    expect(first.created).toBe(true);
    expect([again, c1, c2].map((one) => [one.id, one.created])).toEqual([[first.id, false], [first.id, false], [first.id, false]]);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments WHERE visit_id = $1`, [visitId])).toBe(1);

    // والتوقيع بعدها يربط الشدّة الموجودة ولا يُدرج ثانية.
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr-aqlan", orthoSession: session(legacyCase) });
    expect(signed.reason).toBeNull();
    expect(signed.orthoAdjustmentId).toBe(first.id);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments WHERE visit_id = $1`, [visitId])).toBe(1);
  });

  it("without a visit the API keeps its old behaviour (each call is a new adjustment)", async () => {
    const input = {
      caseId: legacyCase, visitId: null, doneOn: TODAY, phase: null, upperWire: null, lowerWire: null,
      elastics: "none" as const, elasticNote: null, done: null, nextWeeks: 4, note: null, recordedBy: "dr",
    };
    const a = await recordAdjustment(input);
    const b = await recordAdjustment(input);
    expect(a.ok && b.ok && a.id !== b.id && a.created && b.created).toBe(true);
  });

  it("a case of another patient is refused: the sign rolls back entirely", async () => {
    otherCase = (await q<{ id: number }>(`INSERT INTO ortho_cases (patient_id, created_by) VALUES ($1, 'admin') RETURNING id`, [otherPatient]))[0].id;
    const visitId = await openVisit(legacyPatient, "سارة علي");
    const result = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr", orthoSession: session(otherCase) });
    expect(result.reason).toBe("ortho_case_invalid");
    expect(await q(`SELECT signed_at FROM visits WHERE id = $1`, [visitId])).toEqual([{ signed_at: null }]);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments WHERE visit_id = $1`, [visitId])).toBe(0);
    const direct = await recordAdjustment({
      caseId: otherCase, visitId, doneOn: TODAY, phase: null, upperWire: null, lowerWire: null,
      elastics: "none", elasticNote: null, done: null, nextWeeks: 4, note: null, recordedBy: "dr",
    });
    expect(direct).toEqual({ ok: false, message: "الزيارة وحالة التقويم لمريضين مختلفين." });
  });
});

describe("(CASE-1) duplicate adjustments report (read-only)", () => {
  it("lists historical duplicate (case, visit) pairs and changes nothing", async () => {
    const visitId = (await q<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, status) VALUES ('مريض آخر', $1, 'done') RETURNING id`, [otherPatient]))[0].id;
    // ما قبل CASE-1: إدراجٌ بلا بحث — صفّان للزيارة نفسها.
    for (let i = 0; i < 2; i += 1) {
      await q(`INSERT INTO ortho_adjustments (case_id, visit_id, done_on, recorded_by) VALUES ($1, $2, '2026-06-01', 'reception')`, [otherCase, visitId]);
    }
    const total = await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments`);
    const rows = await listOrthoDuplicateAdjustments();
    expect(rows).toEqual([expect.objectContaining({ caseId: otherCase, visitId, patientId: otherPatient, count: 2, firstDoneOn: "2026-06-01", recordedBy: "reception" })]);

    const report = await buildReport("ortho-duplicate-adjustments", parseFilters(new URLSearchParams({ preset: "today" }), TODAY));
    expect(report.rows).toHaveLength(1);
    expect(report.rows?.[0]).toMatchObject({ patientName: "مريض آخر", caseId: otherCase, visitId, count: 2 });
    expect(report.kpis.find((kpi) => kpi.key === "extra")?.count).toBe(1);
    const scoped = await buildReport("ortho-duplicate-adjustments",
      parseFilters(new URLSearchParams({ preset: "today", patientId: String(legacyPatient) }), TODAY));
    expect(scoped.rows).toEqual([]);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ortho_adjustments`)).toBe(total);
  });
});
