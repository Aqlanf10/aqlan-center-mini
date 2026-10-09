import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { parseLegacyTreatmentRequest } from "../../lib/legacy-treatment";
import { REQUIRED_LANDMARKS } from "../../lib/ceph";
import { checkBaselineDraft } from "../../lib/ortho-baseline";

/**
 * (ORTHO-ID) هوية حالة التقويم: جسرها العام وسلالة دراسات Ceph — على PostgreSQL 18، ببيانات اصطناعية.
 *
 * يثبّت ما يلي دون أي كاتب مالي جديد:
 *  - تصحيح دراسة Ceph يحتفظ بالمريض والحالة والمرحلة وتاريخ الأشعة والجهاز والمرجع، ولا يعيد T2/T3 إلى T1.
 *  - التقويم السابق (baseline) والاتفاق التاريخي يلتقيان في سياق واحد بأي ترتيب، بلا اتفاق/رصيد/حالة ثانية.
 *  - نطاق الفك واحد بين الجسر العام وحالة التقويم مهما اختلف مسار الإنشاء.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { createLegacyTreatment } = await import("../../lib/legacy-treatment-db");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { invoiceRequestFingerprint } = await import("../../lib/invoice-clinical-linkage");
const {
  ensureSchema, getPool, resetPoolForTesting, recordOrthoBaseline, createOrthoCase, createClinicalCase,
  listPatientCases, createCephAnalysis, updateCephCalibration, completeCephAnalysis, duplicateCephAnalysis,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const TODAY = "2026-10-06";
let doctor = 0;
let orthoService = 0;
let fixture = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic Doctor') RETURNING id`))[0].id;
  orthoService = (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category)
     VALUES ('Synthetic ortho', 100000, TRUE, TRUE, 'ortho') RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const newPatient = async (label: string) => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
  [`SYN-ID-${++fixture}`, `Synthetic ${label}`]))[0].id;

/* ───────────────────────────── Ceph: سلالة التصحيح ───────────────────────────── */

async function approvedStudy(patientId: number, over: {
  orthoCaseId: number | null; phase: "pretreatment" | "during" | "posttreatment" | "followup";
  xrayDate: string | null; device: string | null;
}) {
  const [document] = await q<{ id: number }>(
    `INSERT INTO patient_documents (patient_id, kind, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ($1, 'imaging', 'Synthetic image', 'image/jpeg', 1, $2, $3, 'ortho-id-test') RETURNING id`,
    [patientId, `sha-${fixture}-${over.phase}`, `synthetic/${fixture}-${over.phase}.jpg`]);
  const created = await createCephAnalysis({
    patientId, documentId: document.id, createdBy: "ortho-id-test", orthoCaseId: over.orthoCaseId,
    phase: over.phase, xrayDate: over.xrayDate, device: over.device, refSet: "builtin_default",
  });
  if (!created.ok) throw new Error(created.message);
  const calibrated = await updateCephCalibration(created.id, { x1: 0, y1: 0, x2: 100, y2: 0, mm: 50 }, "ortho-id-test");
  if (!calibrated.ok) throw new Error(calibrated.message);
  // Distinct synthetic points: completion needs presence of the required landmarks, not a clinical result.
  for (const [index, code] of REQUIRED_LANDMARKS.entries()) {
    await q(`INSERT INTO ceph_landmarks (analysis_id, code, x, y, source, confirmed_by) VALUES ($1, $2, $3, $4, 'manual', 'ortho-id-test')`,
      [created.id, code, 40 + (index * 37) % 400, 30 + (index * 53) % 380]);
  }
  const completed = await completeCephAnalysis(created.id, "ortho-id-test");
  if (!completed.ok) throw new Error(completed.message);
  return { id: created.id, documentId: document.id };
}

const readStudyRow = async (id: number) => (await q<{
  patient_id: number; document_id: number; ortho_case_id: number | null; phase: string; xray_date: string | null;
  device: string | null; ref_set: string; study_kind: string; status: string; mm_per_pixel: number | null;
  completed_at: string | null;
}>(
  `SELECT patient_id, document_id, ortho_case_id, phase, xray_date::text AS xray_date, device, ref_set, study_kind,
          status, mm_per_pixel, completed_at::text AS completed_at
     FROM ceph_analyses WHERE id = $1`, [id]))[0];

describe("(ORTHO-ID) Ceph correction lineage", () => {
  it.each([
    { phase: "during" as const, xrayDate: "2026-03-14", device: "Synthetic device A" },
    { phase: "posttreatment" as const, xrayDate: "2026-08-02", device: "Synthetic device B" },
    { phase: "followup" as const, xrayDate: null, device: null },
  ])("a correction of a $phase study stays a $phase study of the same patient, case, date, device and reference", async (study) => {
    const patientId = await newPatient(`ceph ${study.phase}`);
    const ortho = await createOrthoCase({
      patientId, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null, startDate: "2026-01-10",
      plannedMonths: 18, planId: null, note: null, createdBy: "ortho-id-test",
    });
    if (!ortho.ok) throw new Error(ortho.message);
    const original = await approvedStudy(patientId, { orthoCaseId: ortho.id, ...study });
    const before = await readStudyRow(original.id);

    const copy = await duplicateCephAnalysis(original.id, "ortho-id-test");
    if (!copy.ok) throw new Error(copy.message);
    const after = await readStudyRow(copy.id);

    expect(after).toMatchObject({
      patient_id: before.patient_id, document_id: before.document_id, ortho_case_id: ortho.id,
      phase: study.phase, xray_date: study.xrayDate, device: study.device,
      ref_set: before.ref_set, study_kind: before.study_kind, status: "draft", mm_per_pixel: before.mm_per_pixel,
    });
    // The approved original is untouched and keeps its own certificate.
    expect(await readStudyRow(original.id)).toEqual(before);
  });
});

/* ──────────────────── الجسر العام: baseline × الاتفاق التاريخي ──────────────────── */

const legacy = (patientId: number, scope: "both" | "upper" | "lower", key: string) => {
  const parsed = parseLegacyTreatmentRequest({
    currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30",
    serviceId: orthoService, scope, idempotencyKey: key,
  }, TODAY);
  if (!parsed.ok) throw new Error(parsed.message);
  return createLegacyTreatment({
    patientId, request: parsed.value, actor: "admin", actorRole: "admin", canEditOpening: true,
    templates: DEFAULT_SPECIALTY_TEMPLATES,
  });
};
const baseline = (patientId: number, arches: "both" | "upper" | "lower") => {
  const draft = checkBaselineDraft({
    phase: "working", financialMode: "opening_balance", monthsElapsed: 10, monthsRemaining: 8, arches,
    remainingObjectives: "Synthetic remaining objective",
  }, TODAY);
  if (!draft.ok) throw new Error(draft.message);
  return recordOrthoBaseline({ ...draft.value, responsibleDoctorId: doctor, patientId, actor: "dr", actorRole: "doctor" });
};
const footprint = async (patientId: number) => (await q<Record<string, number | string | null>>(
  `SELECT (SELECT COUNT(*)::int FROM clinical_cases WHERE patient_id = $1) AS cases,
          (SELECT COUNT(*)::int FROM ortho_cases WHERE patient_id = $1) AS ortho,
          (SELECT COUNT(*)::int FROM legacy_treatment_agreements WHERE patient_id = $1) AS agreements,
          (SELECT COUNT(*)::int FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1) AS items,
          (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
          (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments,
          (SELECT COALESCE(SUM(amount_minor), 0)::text FROM patient_opening_balances WHERE patient_id = $1) AS opening`,
  [patientId]))[0];

describe("(ORTHO-ID) one orthodontic context whichever of baseline / legacy agreement comes first", () => {
  it("legacy agreement first, baseline second: the baseline reuses the legacy case — nothing duplicated", async () => {
    const patientId = await newPatient("legacy-then-baseline");
    const first = await legacy(patientId, "both", "ortho-id:legacy-first");
    if (!first.ok) throw new Error(first.reason);
    const afterLegacy = await footprint(patientId);

    const second = await baseline(patientId, "both");
    if (!second.ok) throw new Error(second.reason);

    expect(await footprint(patientId)).toEqual({ ...afterLegacy, ortho: 1 });
    const cases = await listPatientCases(patientId);
    expect(cases).toHaveLength(1);
    expect(await q(`SELECT ortho_case_id FROM clinical_cases WHERE patient_id = $1`, [patientId]))
      .toEqual([{ ortho_case_id: second.id }]);
    expect(afterLegacy).toMatchObject({ opening: "180000", agreements: 1, invoices: 0, payments: 0 });
  });

  it("baseline first, legacy agreement second: the agreement bridges the baseline case — nothing duplicated", async () => {
    const patientId = await newPatient("baseline-then-legacy");
    const first = await baseline(patientId, "both");
    if (!first.ok) throw new Error(first.reason);
    const second = await legacy(patientId, "both", "ortho-id:baseline-first");
    if (!second.ok) throw new Error(second.reason);

    expect(await footprint(patientId)).toMatchObject({ cases: 1, ortho: 1, agreements: 1, items: 1, invoices: 0, payments: 0, opening: "180000" });
    expect(await q(`SELECT ortho_case_id FROM clinical_cases WHERE patient_id = $1`, [patientId]))
      .toEqual([{ ortho_case_id: first.id }]);
  });

  it("legacy agreement for both jaws, baseline for one jaw: refused with nothing written", async () => {
    const patientId = await newPatient("scope-conflict");
    const first = await legacy(patientId, "both", "ortho-id:scope-conflict");
    if (!first.ok) throw new Error(first.reason);
    const before = await footprint(patientId);
    const audits = (await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ortho.baseline'`))[0].n;

    expect(await baseline(patientId, "upper")).toMatchObject({ ok: false });

    expect(await footprint(patientId)).toEqual(before);
    expect((await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ortho.baseline'`))[0].n).toBe(audits);
  });

  it("two concurrent baseline writes still leave exactly one case", async () => {
    const patientId = await newPatient("baseline-race");
    const results = await Promise.all([baseline(patientId, "both"), baseline(patientId, "both")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await footprint(patientId)).toMatchObject({ ortho: 1 });
  });
});

describe("(ORTHO-ID) jaw scope is one value in the general bridge and the ortho case", () => {
  it.each([
    { arches: "upper" as const, label: "الفك العلوي" },
    { arches: "lower" as const, label: "الفك السفلي" },
    { arches: "both" as const, label: "الفكّان" },
  ])("a bridge of a $arches ortho case carries the site $label whatever the caller typed", async ({ arches, label }) => {
    const patientId = await newPatient(`bridge-${arches}`);
    const ortho = await createOrthoCase({
      patientId, appliance: "fixed_metal", arches, slot: "022", bracketSystem: null, startDate: "2026-01-10",
      plannedMonths: 18, planId: null, note: null, createdBy: "ortho-id-test",
    });
    if (!ortho.ok) throw new Error(ortho.message);
    const bridged = await createClinicalCase({
      patientId, specialty: "orthodontics", title: "Synthetic bridge", site: null, problem: null,
      responsiblePartyId: null, orthoCaseId: ortho.id, actor: "reception",
    });
    if (!bridged.ok) throw new Error(bridged.reason);
    expect(bridged.case.site).toBe(label);
  });

  it("a later ortho invoice for the same jaw reuses the bridged case instead of opening a second public case", async () => {
    const patientId = await newPatient("invoice-after-bridge");
    const ortho = await createOrthoCase({
      patientId, appliance: "fixed_metal", arches: "upper", slot: "022", bracketSystem: null, startDate: "2026-01-10",
      plannedMonths: 18, planId: null, note: null, createdBy: "ortho-id-test",
    });
    if (!ortho.ok) throw new Error(ortho.message);
    const bridged = await createClinicalCase({
      patientId, specialty: "orthodontics", title: "Synthetic bridge", site: null, problem: null,
      responsiblePartyId: null, orthoCaseId: ortho.id, actor: "reception",
    });
    if (!bridged.ok) throw new Error(bridged.reason);

    const items = [{
      serviceId: orthoService, category: "ortho", doctorId: doctor, description: "Synthetic ortho", quantity: 1,
      unitPriceMinor: 100_000, toothCode: null, caseId: null, sessions: null, surfaces: null, episodeTeeth: null, scope: "upper",
    }];
    await createLinkedInvoice({
      patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "reception", actorRole: "reception",
      items, templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: "ortho-id:invoice-after-bridge",
      requestHash: invoiceRequestFingerprint({ patientId, currency: "YER", discountMinor: 0, items }), auditDetails: {},
    });

    const rows = await q<{ id: number; ortho_case_id: number | null }>(
      `SELECT id, ortho_case_id FROM clinical_cases WHERE patient_id = $1 AND specialty = 'orthodontics' ORDER BY id`, [patientId]);
    expect(rows).toEqual([{ id: bridged.case.id, ortho_case_id: ortho.id }]);
  });
});
