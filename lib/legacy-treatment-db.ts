/**
 * (INV-LEGACY) علاجٌ بدأ قبل النظام — داخل مسار الربط السريري للفاتورة، في معاملةٍ واحدة.
 *
 * اتفاقٌ تاريخي (المتفق، والمدفوع قبل النظام، والمتبقي عند البدء، وتاريخ المعلومات، والعملة) ← بند خطة (هوية العمل،
 * مغطّى ماليًا دون اختلاق موافقة سريرية، فلا تفوتره الزيارات) ← حالة تخصصية (تُعاد المفتوحة الموافقة، أو تُجسَر حالة
 * التقويم القائمة، أو تُفتح حالةٌ موسومة «حالة بدأت قبل النظام» — بلا تفاصيل سريرية مختلقة).
 *
 * المال: لا سند للمدفوع سابقًا ولا حركة صندوق/وردية ولا فاتورة. المتبقي وحده رصيدٌ سابق — بمحرّك الرصيد الافتتاحي
 * القائم نفسه (`setPatientOpeningBalanceInTx` بأقفاله وسجلّه، والإضافة فقط لمن لا يملك التعديل). والإبطال (للمدير)
 * يصحّح الرصيد بمسار المحرّك نفسه (تعديل أو مسح بسجلّه) ويحفظ البند للمراجعة المالية — ولا يحذف شيئًا.
 * التصميم: docs/INVOICE_FIRST_LEGACY_TREATMENT.md.
 */
import { createHash } from "node:crypto";
import {
  CLINIC_TIME_ZONE, OpeningBalanceChanged, OpeningBalanceExists, PLAN_ITEM_FINANCIAL_LINEAGE_SQL, PLAN_ITEM_FINANCIAL_REVIEW_SQL, PLAN_ITEM_LEGACY_LINEAGE_SQL, PLAN_ITEM_LEGACY_CONTEXT_SQL, clearPatientOpeningBalanceInTx, ensureSchema,
  getPool, insertAuditRow, insertPlanV2InTx, isPeriodLocked, setPatientOpeningBalanceInTx,
  type AuditInput, type DbClient,
} from "./db";
import {
  LINKAGE_SPECIALTY_LABEL, caseSiteFits, caseSiteOverlaps, lineLinkage, scopeNote, sessionsFor, siteText, validateLineSite, type LineSite,
  type LinkageSpecialty,
} from "./invoice-clinical-linkage";
import { legacyCoverageOverlaps, legacyCoverageStateFromContext, legacyCoverageStateFromSnapshot, type LegacyCoverageState } from "./legacy-treatment-coverage";
import { isAdmin } from "./roles";
import { isLegacyVoidMode, parseLegacyVoidRequest, previewLegacyVoid, type LegacyVoidMode, type LegacyVoidPreview } from "./legacy-treatment-void";
import { reusableMaster } from "./invoice-linkage-db";
import {
  legacyCaseTitle, legacyTreatmentFingerprint,
  type LegacyTreatmentPreview, type LegacyTreatmentRefusal, type LegacyTreatmentRequest, type LegacyVoidRefusal,
} from "./legacy-treatment";
import { formatMoney, isCurrency, type Currency } from "./money";
import { clinicDateString } from "./schedule";
import type { SpecialtyTemplate } from "./specialty-templates";

export interface LegacyAgreementView {
  id: number;
  patientId: number;
  planItemId: number;
  planId: number;
  caseId: number | null;
  caseTitle: string | null;
  serviceId: number;
  serviceName: string;
  specialty: string;
  specialtyLabel: string;
  toothCode: number | null;
  currency: Currency;
  agreedMinor: number;
  previouslyPaidMinor: number;
  remainingMinor: number;
  historicalAsOf: string;
  openingEffect: "none" | "created" | "increased";
  openingHistoryId: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  status: "live" | "void";
  voidedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  coverageState: LegacyCoverageState["kind"];
  coverageSite: Readonly<LineSite> | null;
}

interface AgreementRow {
  id: number; patient_id: number; plan_item_id: number; plan_id: number; case_id: number | null; case_title: string | null;
  service_id: number; service_name: string; specialty: string; tooth_code: number | null; currency: string;
  agreed_minor: string; previously_paid_minor: string; remaining_minor: string; historical_as_of: string;
  opening_effect: "none" | "created" | "increased"; opening_history_id: number | null; note: string | null;
  created_by: string; created_at: Date; status: "live" | "void"; voided_by: string | null; voided_at: Date | null;
  void_reason: string | null;
  coverage_snapshot: unknown;
}

const AGREEMENT_SELECT = `
  SELECT a.id, a.patient_id, a.plan_item_id, i.plan_id, a.case_id, c.title AS case_title, a.service_id, a.service_name,
         a.specialty, a.tooth_code, a.currency, a.agreed_minor::text, a.previously_paid_minor::text,
         a.remaining_minor::text, a.historical_as_of::text, a.opening_effect, a.opening_history_id, a.note,
         a.created_by, a.created_at, a.status, a.voided_by, a.voided_at, a.void_reason, to_jsonb(cs) AS coverage_snapshot
    FROM legacy_treatment_agreements a
    JOIN plan_items i ON i.id = a.plan_item_id
    LEFT JOIN clinical_cases c ON c.id = a.case_id AND c.patient_id = a.patient_id
    LEFT JOIN legacy_treatment_coverage_snapshots cs ON cs.agreement_id = a.id`;

function toView(row: AgreementRow): LegacyAgreementView {
  const coverage = legacyCoverageStateFromSnapshot(row.coverage_snapshot, {
    agreementId: row.id, serviceId: row.service_id, anchorToothCode: row.tooth_code,
  });
  if (!isCurrency(row.currency)) throw new Error(`عملة اتفاق تاريخي غير صالحة: ${row.currency}`);
  return {
    id: row.id, patientId: row.patient_id, planItemId: row.plan_item_id, planId: row.plan_id,
    caseId: row.case_id, caseTitle: row.case_title, serviceId: row.service_id, serviceName: row.service_name,
    specialty: row.specialty,
    specialtyLabel: (LINKAGE_SPECIALTY_LABEL as Record<string, string>)[row.specialty] ?? row.specialty,
    toothCode: row.tooth_code, currency: row.currency,
    agreedMinor: Number(row.agreed_minor), previouslyPaidMinor: Number(row.previously_paid_minor),
    remainingMinor: Number(row.remaining_minor), historicalAsOf: row.historical_as_of,
    openingEffect: row.opening_effect, openingHistoryId: row.opening_history_id, note: row.note,
    createdBy: row.created_by, createdAt: row.created_at.toISOString(), status: row.status,
    voidedBy: row.voided_by, voidedAt: row.voided_at?.toISOString() ?? null, voidReason: row.void_reason,
    coverageState: coverage.kind, coverageSite: coverage.kind === "verified" ? coverage.coverage.site : null,
  };
}

export async function listLegacyTreatments(patientId: number): Promise<LegacyAgreementView[]> {
  await ensureSchema();
  const { rows } = await getPool().query<AgreementRow>(
    `${AGREEMENT_SELECT} WHERE a.patient_id = $1 ORDER BY (a.status = 'live') DESC, a.id DESC`, [patientId]);
  return rows.map(toView);
}

async function readAgreement(id: number): Promise<LegacyAgreementView> {
  const { rows: [row] } = await getPool().query<AgreementRow>(`${AGREEMENT_SELECT} WHERE a.id = $1`, [id]);
  return toView(row);
}

class Refusal extends Error {
  constructor(readonly reason: LegacyTreatmentRefusal | LegacyVoidRefusal) { super(reason); }
}

async function audit(client: DbClient, entry: AuditInput) { await insertAuditRow(client, entry); }

/** الرصيد السابق بهذه العملة «ملك الاتفاقات» إن كان أصله مجموعَ متبقيات الاتفاقات الحيّة التي أنشأته أو زادته بالضبط. */
async function liveAgreementRemaining(client: DbClient, patientId: number, currency: Currency): Promise<number> {
  const { rows: [row] } = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(remaining_minor), 0)::text AS total FROM legacy_treatment_agreements
      WHERE patient_id = $1 AND currency = $2 AND status = 'live' AND opening_effect <> 'none'`,
    [patientId, currency]);
  return Number(row.total);
}

async function lockedOpening(client: DbClient, patientId: number, currency: Currency, lock = true) {
  const { rows: [row] } = await client.query<{ amount_minor: string; as_of_date: string; note: string | null }>(
    `SELECT amount_minor::text, as_of_date::text, note FROM patient_opening_balances
      WHERE patient_id = $1 AND currency = $2${lock ? " FOR UPDATE" : ""}`, [patientId, currency]);
  return row ? { amountMinor: Number(row.amount_minor), asOfDate: row.as_of_date, note: row.note } : null;
}

export type CreateLegacyTreatmentResult =
  | { ok: true; replayed: boolean; agreement: LegacyAgreementView; caseCreated: boolean }
  | { ok: false; reason: LegacyTreatmentRefusal };

export async function createLegacyTreatment(input: {
  patientId: number;
  request: LegacyTreatmentRequest;
  actor: string;
  actorRole: string | null;
  /** من يملك تعديل الرصيد السابق (المدير): يضيف المتبقي إلى رصيدٍ أنشأته اتفاقاتٌ سابقة. وغيره يُنشئ فقط. */
  canEditOpening: boolean;
  templates: readonly SpecialtyTemplate[];
}): Promise<CreateLegacyTreatmentResult> {
  await ensureSchema();
  const written = await writeLegacyTreatment(input);
  if (!written.ok) return written;
  return { ok: true, replayed: written.replayed, caseCreated: written.caseCreated, agreement: await readAgreement(written.id) };
}

/** ما سيفعله الحفظ بالاتفاق — يقرّره الكاتب تحت الأقفال، وتقرأه المعاينة بلا أقفال ولا كتابة، بالقواعد نفسها. */
interface LegacyDecision {
  service: { id: number; name: string; category: string | null };
  specialty: LinkageSpecialty;
  needsCase: boolean;
  site: LineSite;
  masterId: number | null;
  opening: {
    effect: "none" | "created" | "increased";
    before: { amountMinor: number; asOfDate: string } | null;
    after: { amountMinor: number; asOfDate: string } | null;
    existingNote: string | null;
  };
  /** الحالة: لا حاجة، أو قائمة تُعاد، أو جديدة (جسرٌ لحالة تقويم قائمة إن وُجدت)، أو يلزم اختيار المستخدم. */
  casePlan:
    | { mode: "none" }
    | { mode: "existing"; id: number; title: string | null }
    | { mode: "new"; orthoCaseId: number | null; title: string }
    | { mode: "choose"; options: { id: number; title: string }[] };
}

/**
 * القرار الواحد للحفظ والمعاينة. `lock` للكاتب وحده (FOR UPDATE)؛ المعاينة تقرأ في معاملة قراءة فقط.
 * ترمي `Refusal` بالسبب نفسه الذي يرفض به الحفظ.
 */
async function decideLegacyTreatment(client: DbClient, input: {
  patientId: number; request: LegacyTreatmentRequest; canEditOpening: boolean;
}, lock: boolean): Promise<LegacyDecision> {
  const { patientId, request } = input;
  const { rows: [service] } = await client.query<{ id: number; name: string; category: string | null }>(
    `SELECT id, name, category FROM services WHERE id = $1 AND is_active = TRUE`, [request.serviceId]);
  const linkage = service ? lineLinkage({ serviceId: service.id, category: service.category }) : { kind: "financial" as const };
  if (!service || linkage.kind !== "clinical") throw new Refusal("bad_service");
  /* (INV-LINK TOOTH) القاعدة نفسها التي تحكم بند الفاتورة: خدمةٌ تخص سنًّا بلا سن لا تُسجَّل (fail closed). */
  const checked = validateLineSite({
    category: service.category, toothCode: request.toothCode, surfaces: request.surfaces,
    episodeTeeth: request.episodeTeeth, scope: request.scope,
  });
  if (!checked.ok) throw new Refusal(checked.reason as LegacyTreatmentRefusal);
  const site = checked.site;
  // The complete normalized site is captured atomically below; it never creates per-tooth prices/items.
  if (lock) {
    await client.query(`SELECT id FROM treatment_plans WHERE patient_id = $1 ORDER BY id FOR UPDATE`, [patientId]);
    await client.query(`SELECT i.id FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      WHERE t.patient_id = $1 ORDER BY i.id FOR UPDATE OF i`, [patientId]);
  }

  // Existing identity survives cancellation, void, and drift in mutable plan/item patient or service.
  const { rows: priorWork } = await client.query<{
    id: number; case_id: number | null; tooth_code: number | null; case_site: string | null; status: string; plan_status: string; case_status: string | null;
    financial_review: boolean; financial_lineage: boolean; has_legacy: boolean; live_legacy: boolean; legacy_context: unknown;
  }>(
    `SELECT i.id, i.case_id, i.tooth_code, c.site AS case_site, i.status, t.status AS plan_status, c.status AS case_status,
      ${PLAN_ITEM_FINANCIAL_REVIEW_SQL} AS financial_review, ${PLAN_ITEM_FINANCIAL_LINEAGE_SQL} AS financial_lineage,
      EXISTS (SELECT 1 FROM legacy_treatment_agreements la WHERE la.plan_item_id = i.id) AS has_legacy,
      EXISTS (SELECT 1 FROM legacy_treatment_agreements la WHERE la.plan_item_id = i.id AND la.status = 'live') AS live_legacy, ${PLAN_ITEM_LEGACY_CONTEXT_SQL} AS legacy_context
     FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id LEFT JOIN clinical_cases c ON c.id = i.case_id
     WHERE ((t.patient_id = $1 AND i.service_id = $2) OR EXISTS (
       SELECT 1 FROM legacy_treatment_agreements legacy_identity
       WHERE legacy_identity.plan_item_id = i.id AND legacy_identity.patient_id = $1 AND legacy_identity.service_id = $2))
       AND (i.tooth_code IS NOT DISTINCT FROM $3::smallint OR i.tooth_code = ANY($4::smallint[])
         OR i.tooth_code IS NULL OR $3::smallint IS NULL OR ${PLAN_ITEM_LEGACY_LINEAGE_SQL})
     ORDER BY i.id`, [patientId, service.id, site.toothCode, site.episodeTeeth ?? (site.toothCode === null ? [] : [site.toothCode])]);
  for (const prior of priorWork) {
    if (prior.has_legacy) {
      const coverage = legacyCoverageStateFromContext(prior.legacy_context);
      if (!legacyCoverageOverlaps(coverage, site)) continue;
      if (coverage.kind !== "verified") throw new Refusal("needs_financial_review");
    } else if (!caseSiteOverlaps(prior.tooth_code === null ? prior.case_site : String(prior.tooth_code), site)) continue;
    // An explicit different episode may follow closed, completed, financially resolved ordinary work.
    // Existing legacy live-scope uniqueness is deliberately retained until episode identity is redesigned.
    if (!prior.has_legacy && request.caseId !== null && prior.case_id !== null && request.caseId !== prior.case_id
      && prior.status === "done" && (prior.case_status === "completed" || prior.case_status === "closed")
      && !prior.financial_review) continue;
    if (prior.financial_review) throw new Refusal("needs_financial_review");
    if (prior.live_legacy) throw new Refusal("duplicate_live");
    if (prior.financial_lineage) throw new Refusal("needs_financial_review");
    if (prior.plan_status === "active" && (prior.status === "planned" || prior.status === "in_progress")) {
      throw new Refusal("open_item_exists");
    }
    throw new Refusal("needs_financial_review");
  }
  const masterId = await reusableMaster(client, patientId, request.currency);
  if (masterId === false) throw new Refusal("incompatible_plan");

  /* (LEGACY-FIX) مدفوعٌ قديم قد يكون أُدخل سندَ قبض عامًّا (غير مرتبط بفاتورة أو خطة أو رصيد سابق). تسجيل «المدفوع قبل النظام»
     فوقه يخصم المبلغ نفسه مرتين. لا يصنّف النظام السند من ملاحظته ولا يعكسه: يُرفض التسجيل حتى يراجعه المدير. */
  if (request.previouslyPaidMinor > 0) {
    const { rows: [unallocated] } = await client.query<{ receipts: string }>(
      `SELECT COUNT(*)::text AS receipts FROM payments p
        WHERE p.patient_id = $1 AND p.kind = 'payment' AND p.invoice_id IS NULL AND p.plan_id IS NULL
          AND p.opening_currency IS NULL AND p.reversal_of_id IS NULL
          AND p.amount_minor > COALESCE((SELECT SUM(r.amount_minor) FROM payments r
            WHERE r.reversal_of_id = p.id AND r.kind = 'refund'), 0)`, [patientId]);
    if (unallocated.receipts !== "0") throw new Refusal("prior_receipts_review");
  }

  // ── الرصيد السابق: المتبقي وحده، بمحرّك الرصيد الافتتاحي نفسه ──
  let opening: LegacyDecision["opening"] = { effect: "none", before: null, after: null, existingNote: null };
  if (request.remainingMinor > 0) {
    const existing = await lockedOpening(client, patientId, request.currency, lock && input.canEditOpening);
    if (existing) {
      /* رصيدٌ قائم: يُضاف إليه فقط إن كان كلّه متبقيات اتفاقاتٍ حيّة (لا رصيدٌ يدوي قد يشمل هذا العلاج فيُحسب مرتين)،
         والإضافة إلى رصيدٍ قائم تعديلٌ — للمدير وحده كما في المحرّك. */
      if (existing.amountMinor !== await liveAgreementRemaining(client, patientId, request.currency)) {
        throw new Refusal("opening_not_owned");
      }
      if (!input.canEditOpening) throw new Refusal("opening_edit_forbidden");
      const asOfDate = existing.asOfDate < request.historicalAsOf ? existing.asOfDate : request.historicalAsOf;
      if (await isPeriodLocked(existing.asOfDate) || await isPeriodLocked(asOfDate)) throw new Refusal("period_locked");
      opening = {
        effect: "increased", existingNote: existing.note,
        before: { amountMinor: existing.amountMinor, asOfDate: existing.asOfDate },
        after: { amountMinor: existing.amountMinor + request.remainingMinor, asOfDate },
      };
    } else {
      if (await isPeriodLocked(request.historicalAsOf)) throw new Refusal("period_locked");
      opening = { effect: "created", existingNote: null, before: null,
        after: { amountMinor: request.remainingMinor, asOfDate: request.historicalAsOf } };
    }
  }

  // ── الحالة التخصصية: المفتوحة الموافقة تُعاد، أو تُجسَر حالة التقويم القائمة، أو تُفتح حالةٌ موسومة ──
  const specialty = linkage.specialty;
  let casePlan: LegacyDecision["casePlan"] = { mode: "none" };
  if (linkage.needsCase) {
    const forUpdate = lock ? " FOR UPDATE" : "";
    if (request.caseId !== null) {
      const { rows: [chosen] } = await client.query<{ id: number; title: string | null; site: string | null }>(
        `SELECT id, title, site FROM clinical_cases WHERE id = $1 AND patient_id = $2 AND specialty = $3 AND status IN ('active', 'waiting')
          AND (ortho_case_id IS NULL OR EXISTS (SELECT 1 FROM ortho_cases o WHERE o.id = ortho_case_id AND o.patient_id = $2 AND o.status IN ('active', 'retention')))${forUpdate}`,
        [request.caseId, patientId, specialty]);
      if (!chosen || !caseSiteFits(specialty, chosen.site, site)) throw new Refusal("bad_case");
      casePlan = { mode: "existing", id: chosen.id, title: chosen.title };
    } else {
      const { rows: sameSpecialty } = await client.query<{ id: number; title: string | null; site: string | null }>(
        `SELECT id, title, site FROM clinical_cases WHERE patient_id = $1 AND specialty = $2 AND status IN ('active', 'waiting')
          AND (ortho_case_id IS NULL OR EXISTS (SELECT 1 FROM ortho_cases o WHERE o.id = ortho_case_id AND o.patient_id = $1 AND o.status IN ('active', 'retention')))
          ORDER BY id${forUpdate}`, [patientId, specialty]);
      const open = sameSpecialty.filter((row) => caseSiteFits(specialty, row.site, site));
      if (open.length > 1) {
        casePlan = { mode: "choose", options: open.map((row) => ({ id: row.id, title: row.title ?? `#${row.id}` })) };
      } else if (open.length === 1) {
        casePlan = { mode: "existing", id: open[0].id, title: open[0].title };
      } else {
        let orthoCaseId: number | null = null;
        if (specialty === "orthodontics") {
          const { rows: [ortho] } = await client.query<{ id: number }>(
            `SELECT o.id FROM ortho_cases o
              WHERE o.patient_id = $1 AND o.status IN ('active', 'retention')
                AND NOT EXISTS (SELECT 1 FROM clinical_cases cc WHERE cc.ortho_case_id = o.id)
              ORDER BY o.id DESC LIMIT 1`, [patientId]);
          orthoCaseId = ortho?.id ?? null;
        }
        casePlan = { mode: "new", orthoCaseId, title: orthoCaseId !== null ? "تقويم الأسنان" : legacyCaseTitle(specialty, site) };
      }
    }
  }
  return { service, specialty, needsCase: linkage.needsCase, site, masterId, opening, casePlan };
}

export type LegacyTreatmentPreviewResult =
  | { ok: true; replayed: boolean; preview: LegacyTreatmentPreview }
  | { ok: false; reason: LegacyTreatmentRefusal };

/**
 * (LEGACY-FIX) معاينة التسجيل من بيانات الاتفاق التاريخي نفسها وبقرار الحفظ نفسه — قراءةٌ فقط في معاملة READ ONLY.
 * لا سعر فاتورة ولا صلاحية تسعير؛ والحفظ يعيد القرار تحت الأقفال (المعاينة ليست وعدًا).
 */
export async function previewLegacyTreatment(input: {
  patientId: number; request: LegacyTreatmentRequest; canEditOpening: boolean;
}): Promise<LegacyTreatmentPreviewResult> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [patient] } = await client.query(`SELECT id FROM patients WHERE id = $1`, [input.patientId]);
    if (!patient) throw new Refusal("no_patient");
    let replayed = false;
    if (input.request.idempotencyKey) {
      const { rows: [prior] } = await client.query<{ idempotency_request_hash: string | null; patient_id: number }>(
        `SELECT idempotency_request_hash, patient_id FROM legacy_treatment_agreements WHERE idempotency_key = $1`,
        [input.request.idempotencyKey]);
      if (prior) {
        if (prior.idempotency_request_hash !== legacyTreatmentFingerprint(input.patientId, input.request)
          || prior.patient_id !== input.patientId) throw new Refusal("idempotency_conflict");
        replayed = true;
      }
    }
    const decision = replayed ? null : await decideLegacyTreatment(client, input, false);
    const preview: LegacyTreatmentPreview = decision === null
      ? { case: null, opening: null }
      : {
        case: decision.casePlan.mode === "none" ? { mode: "none", id: null, title: null, options: [] }
          : decision.casePlan.mode === "existing" ? { mode: "existing", id: decision.casePlan.id, title: decision.casePlan.title, options: [] }
          : decision.casePlan.mode === "choose" ? { mode: "choose", id: null, title: null, options: decision.casePlan.options }
          : { mode: decision.casePlan.orthoCaseId !== null ? "bridge" : "new", id: null, title: decision.casePlan.title, options: [] },
        opening: { effect: decision.opening.effect, beforeMinor: decision.opening.before?.amountMinor ?? null,
          afterMinor: decision.opening.after?.amountMinor ?? null, currency: input.request.currency },
      };
    return { ok: true, replayed, preview };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason as LegacyTreatmentRefusal };
    throw error;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function writeLegacyTreatment(input: Parameters<typeof createLegacyTreatment>[0]):
  Promise<{ ok: true; id: number; replayed: boolean; caseCreated: boolean } | { ok: false; reason: LegacyTreatmentRefusal }> {
  const { patientId, request } = input;
  const requestHash = request.idempotencyKey ? legacyTreatmentFingerprint(patientId, request) : null;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Same patient-first financial fence as invoice creation, signatures and plan edits.
    // The opening engine retains its own add-only fence when a new opening is actually inserted.
    const { rows: [patient] } = await client.query(`SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE`, [patientId]);
    if (!patient) throw new Refusal("no_patient");

    if (request.idempotencyKey) {
      const { rows: [prior] } = await client.query<{ id: number; idempotency_request_hash: string | null; patient_id: number }>(
        `SELECT id, idempotency_request_hash, patient_id FROM legacy_treatment_agreements WHERE idempotency_key = $1`,
        [request.idempotencyKey]);
      if (prior) {
        if (prior.idempotency_request_hash !== requestHash || prior.patient_id !== patientId) {
          throw new Refusal("idempotency_conflict");
        }
        await client.query("ROLLBACK");
        return { ok: true, id: prior.id, replayed: true, caseCreated: false };
      }
    }

    const decision = await decideLegacyTreatment(client, input, true);
    if (decision.casePlan.mode === "choose") throw new Refusal("ambiguous_case");
    const { service, specialty, site, masterId } = decision;

    const amounts = `المتفق ${formatMoney(request.agreedMinor, request.currency)} · المدفوع قبل النظام `
      + `${formatMoney(request.previouslyPaidMinor, request.currency)} · المتبقي ${formatMoney(request.remainingMinor, request.currency)}`;

    // ── الرصيد السابق: المتبقي وحده، بمحرّك الرصيد الافتتاحي نفسه ──
    const openingEffect = decision.opening.effect;
    const openingBefore = decision.opening.before;
    const openingAfter = decision.opening.after;
    let openingHistoryId: number | null = null;
    if (openingEffect === "increased" && openingBefore && openingAfter) {
      const saved = await setPatientOpeningBalanceInTx(client, {
        patientId, currency: request.currency, amountMinor: openingAfter.amountMinor, asOfDate: openingAfter.asOfDate,
        note: decision.opening.existingNote, createdBy: input.actor, addOnly: false, expectedBefore: openingBefore,
        reason: `إضافة متبقي علاجٍ بدأ قبل النظام — ${service.name}: ${amounts}`,
      });
      if (!saved) throw new Refusal("no_patient");
      openingHistoryId = saved.historyId;
    } else if (openingEffect === "created" && openingAfter) {
      const saved = await setPatientOpeningBalanceInTx(client, {
        patientId, currency: request.currency, amountMinor: request.remainingMinor, asOfDate: request.historicalAsOf,
        note: `متبقي علاجٍ بدأ قبل النظام — ${service.name}: ${amounts}`, createdBy: input.actor,
        addOnly: !input.canEditOpening, expectedBefore: null,
      });
      if (!saved) throw new Refusal("no_patient");
      openingHistoryId = saved.historyId;
    }

    // Historical financial coverage is not current clinical consent. Reuse the compatible canonical master.
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const where = siteText(site);
    const planTitle = `علاج بدأ قبل النظام — ${service.name}${where ? ` — ${site.toothCode !== null && !site.episodeTeeth?.[1] ? `سن ${where}` : where}` : ""}`;
    const plan = await insertPlanV2InTx(client, {
      patientId, title: planTitle, specialty, primaryDoctorId: null, billingMode: "per_procedure",
      baseCurrency: request.currency, startDate: request.historicalAsOf <= today ? request.historicalAsOf : today,
      note: `اتفاق تاريخي حتى ${request.historicalAsOf}: ${amounts}. لا يُفوتر — المتبقي في الرصيد السابق.`,
      items: [{
        serviceId: service.id, serviceName: service.name, category: service.category, toothCode: site.toothCode,
        surfaces: site.surfaces, quantity: 1, unitPriceMinor: request.agreedMinor, billingRule: "on_completion" as const,
        sessionCount: sessionsFor(service.category, request.sessions, input.templates),
        note: scopeNote(site) ?? (site.episodeTeeth && site.episodeTeeth.length > 1 ? `الأسنان: ${site.episodeTeeth.join("، ")}` : null),
      }],
      installments: [],
      createdBy: input.actor,
    }, masterId);
    if (!plan.ok) throw new Refusal("incompatible_plan");
    const itemId = plan.itemIds[0];
    await client.query(`UPDATE plan_items SET billing_status = 'included_in_package' WHERE id = $1`, [itemId]);
    await audit(client, {
      action: masterId === null ? "plan.create" : "plan.item_update", entity: "patient", entityId: patientId, entityLabel: planTitle,
      details: { الخطة: plan.planId, البنود: 1, المصدر: "علاج بدأ قبل النظام", الموافقة_السريرية: "لم تُسجّل بهذا الإدخال", التغطية: "مشمول بالاتفاق التاريخي" },
      actor: input.actor, actorRole: input.actorRole,
    });

    // ── الحالة التخصصية كما قرّرها `decideLegacyTreatment` تحت الأقفال ──
    let caseId: number | null = null;
    let caseCreated = false;
    if (decision.casePlan.mode === "existing") {
      caseId = decision.casePlan.id;
    } else if (decision.casePlan.mode === "new") {
      const { orthoCaseId, title } = decision.casePlan;
      const { rows: [created] } = await client.query<{ id: number }>(
        `INSERT INTO clinical_cases (patient_id, specialty, title, site, ortho_case_id, created_by, origin)
         VALUES ($1, $2, $3, $4::text, $5::int, $6, 'clinical') RETURNING id`,
        [patientId, specialty, title, siteText(site), orthoCaseId, input.actor]);
      caseId = created.id;
      caseCreated = true;
      await audit(client, {
        action: "case.create", entity: "patient", entityId: patientId, entityLabel: title,
        details: {
          الحالة: caseId, التخصص: LINKAGE_SPECIALTY_LABEL[specialty], المصدر: "علاج بدأ قبل النظام",
          جسر_التقويم: orthoCaseId ?? "—", وضع_الحالة: "حالة بدأت قبل النظام",
        },
        actor: input.actor, actorRole: input.actorRole,
      });
    }
    if (decision.needsCase) {
      await client.query(`UPDATE plan_items SET case_id = $2 WHERE id = $1`, [itemId, caseId]);
      await audit(client, {
        action: "plan.item_case", entity: "patient", entityId: patientId, entityLabel: service.name,
        details: { البند: itemId, الحالة: caseId, المصدر: "علاج بدأ قبل النظام" },
        actor: input.actor, actorRole: input.actorRole,
      });
    }

    const { rows: [agreement] } = await client.query<{ id: number }>(
      `INSERT INTO legacy_treatment_agreements
         (patient_id, plan_item_id, case_id, service_id, service_name, specialty, tooth_code, currency, agreed_minor,
          previously_paid_minor, remaining_minor, historical_as_of, opening_effect, opening_history_id, note,
          idempotency_key, idempotency_request_hash, created_by)
       VALUES ($1, $2, $3::int, $4, $5, $6, $7::smallint, $8, $9, $10, $11, $12::date, $13, $14::int, $15::text,
               $16::text, $17::text, $18)
       RETURNING id`,
      [patientId, itemId, caseId, service.id, service.name, specialty, site.toothCode, request.currency,
        request.agreedMinor, request.previouslyPaidMinor, request.remainingMinor, request.historicalAsOf, openingEffect,
        openingHistoryId, request.note, request.idempotencyKey, requestHash, input.actor]);

    // Only this new-registration transaction captures coverage. No old-row backfill or evidence-guessing endpoint exists.
    await client.query(
      `INSERT INTO legacy_treatment_coverage_snapshots
         (agreement_id, format_version, service_id, service_category, anchor_tooth_code,
          snapshot_mode, snapshot_tooth_codes, snapshot_scope, snapshot_surfaces, recorded_by)
       VALUES ($1, 1, $2, $3, $4::smallint, $5, $6::smallint[], $7::text, $8::text, $9)`,
      [agreement.id, service.id, service.category, site.toothCode, site.mode,
        site.episodeTeeth ?? (site.toothCode === null ? [] : [site.toothCode]), site.scope, site.surfaces, input.actor]);

    if (openingAfter) {
      await audit(client, {
        action: "opening_balance.set", entity: "patient", entityId: patientId, entityLabel: service.name,
        details: {
          المبلغ: openingAfter.amountMinor, العملة: request.currency, التاريخ: openingAfter.asOfDate,
          ...(openingBefore ? { المبلغ_السابق: openingBefore.amountMinor, التاريخ_السابق: openingBefore.asOfDate } : {}),
          المصدر: `اتفاق علاج بدأ قبل النظام #${agreement.id}`,
        },
        actor: input.actor, actorRole: input.actorRole,
      });
    }
    await audit(client, {
      action: "legacy_treatment.create", entity: "patient", entityId: patientId, entityLabel: service.name,
      details: {
        الاتفاق: agreement.id, التخصص: LINKAGE_SPECIALTY_LABEL[specialty], السن: siteText(site) ?? "—", التغطية_غير_القابلة_للتعديل: "لقطة موضع كاملة عند التسجيل",
        العملة: request.currency, المتفق: request.agreedMinor, المدفوع_قبل_النظام: request.previouslyPaidMinor,
        المتبقي: request.remainingMinor, حتى_تاريخ: request.historicalAsOf, البند: itemId, الحالة: caseId ?? "—",
        الرصيد_السابق: openingEffect === "none" ? "لا رصيد (مسدَّد تاريخيًّا)" : openingEffect === "created" ? "أُنشئ بالمتبقي" : "أُضيف إليه المتبقي",
        سند: "لا سند للمدفوع سابقًا",
      },
      actor: input.actor, actorRole: input.actorRole,
    });
    await client.query("COMMIT");
    return { ok: true, id: agreement.id, replayed: false, caseCreated };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Refusal) return { ok: false, reason: error.reason as LegacyTreatmentRefusal };
    if (error instanceof OpeningBalanceExists) return { ok: false, reason: "opening_edit_forbidden" };
    if (error instanceof OpeningBalanceChanged) return { ok: false, reason: "opening_changed" };
    const constraint = (error as { code?: string; constraint?: string });
    if (constraint.code === "23505" && constraint.constraint === "legacy_treatment_agreements_idempotency_uniq") {
      return { ok: false, reason: "idempotency_conflict" };
    }
    if (constraint.code === "23505" && constraint.constraint === "legacy_treatment_agreements_live_scope_uniq") {
      return { ok: false, reason: "duplicate_live" };
    }
    throw error;
  } finally {
    client.release();
  }
}

interface VoidAgreementRow {
  status: "live" | "void"; currency: string; remaining_minor: string; opening_effect: "none" | "created" | "increased";
  service_name: string; plan_item_id: number;
}

/**
 * Shared evidence reader. The writer already holds patient -> plans -> item -> agreement locks, then takes the opening lock.
 * New opening collections take FOR SHARE on that opening row in recordPayment, so they cannot cross the locked check.
 * Refunds may only lower net collections; no payment-origin lock is acquired here (avoids reversing financial lock order).
 * Read payments directly: a fully paid agreement or a missing opening row must not hide this patient's collection history.
 */
async function readLegacyVoidPreviewInTx(client: DbClient, input: {
  patientId: number; agreementId: number; actor: string; actorRole: string | null; mode: LegacyVoidMode;
}, agreement: VoidAgreementRow, lock: boolean) {
  if (!isCurrency(agreement.currency)) throw new Refusal("opening_changed");
  const currency = agreement.currency;
  const { rows: [work] } = await client.query<{ plan_id: number; patient_id: number }>(
    `SELECT i.plan_id, t.patient_id FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      WHERE i.id = $1 AND t.patient_id = $2`, [agreement.plan_item_id, input.patientId]);
  if (!work) throw new Refusal("opening_changed");
  const existing = await lockedOpening(client, input.patientId, currency, lock);
  const liveRemaining = await liveAgreementRemaining(client, input.patientId, currency);
  const { rows: collections } = await client.query<{
    currency: string; base_currency: string; native_minor: string; base_minor: string;
    unsupported: string; receipt_count: string; last_receipt_id: number;
  }>(
    `SELECT currency, base_currency,
            SUM((CASE WHEN kind = 'refund' THEN -1 ELSE 1 END) * amount_minor::numeric)::text AS native_minor,
            SUM((CASE WHEN kind = 'refund' THEN -1 ELSE 1 END) * base_amount_minor::numeric)::text AS base_minor,
            COUNT(*) FILTER (WHERE kind NOT IN ('payment', 'refund') OR currency NOT IN ('YER', 'SAR', 'USD')
              OR (currency <> $2 AND $2 <> 'YER')
              OR amount_minor < 0 OR amount_minor > 9007199254740991
              OR (currency <> $2 AND $2 = 'YER' AND (base_currency <> 'YER'
                OR base_amount_minor < 0 OR base_amount_minor > 9007199254740991)))::text AS unsupported,
            COUNT(*)::text AS receipt_count, MAX(id) AS last_receipt_id
       FROM payments WHERE patient_id = $1 AND opening_currency = $2
       GROUP BY currency, base_currency ORDER BY currency, base_currency`, [input.patientId, currency]);
  // Native totals never cross receipt currencies. Only a YER opening may use the already-recorded
  // base subtotals: each receipt/refund keeps its own historical rate and rounding, without reconversion.
  let netCollectionsMinor = 0;
  let collectionsValid = true;
  for (const bucket of collections) {
    const native = bucket.currency === currency;
    const supported = isCurrency(bucket.currency) && (native || (currency === "YER" && bucket.base_currency === "YER"));
    const subtotal = Number(native ? bucket.native_minor : bucket.base_minor);
    // Independent refund rounding can make a foreign-base bucket negative; preserve its signed value.
    // The existing preview policy validates the final target-currency net, without clamping buckets.
    if (!supported || bucket.unsupported !== "0" || !Number.isSafeInteger(subtotal)
      || !Number.isSafeInteger(netCollectionsMinor + subtotal)) {
      collectionsValid = false;
      break;
    }
    netCollectionsMinor += subtotal;
  }
  const { rows: [history] } = await client.query<{ last_history_id: number | null }>(
    `SELECT MAX(id) AS last_history_id FROM patient_opening_balance_history WHERE patient_id = $1 AND currency = $2`,
    [input.patientId, currency]);
  // Same date rule as isPeriodLocked, read from this transaction rather than another pooled connection/cache.
  const { rows: [period] } = await client.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'finance.locked_before'`);
  const lockedBefore = (period?.value ?? "").trim();
  const remaining = Number(agreement.remaining_minor);
  const removed = agreement.opening_effect === "none" ? 0 : remaining;
  const owned = removed === 0 || (existing !== null && existing.amountMinor === liveRemaining && existing.amountMinor >= removed);
  const impact = previewLegacyVoid({
    patientId: input.patientId, agreementId: input.agreementId, currency, status: agreement.status,
    openingPrincipalBeforeMinor: existing?.amountMinor ?? 0, removedPrincipalMinor: removed,
    netCollectionsMinor,
    financialEvidenceValid: collectionsValid && owned && Number.isSafeInteger(liveRemaining)
      && Number.isSafeInteger(remaining) && remaining >= 0
      && ((agreement.opening_effect === "none" && remaining === 0) || (agreement.opening_effect !== "none" && remaining > 0)),
    periodLocked: removed > 0 && existing !== null && lockedBefore !== "" && existing.asOfDate < lockedBefore,
  }, input.mode);
  // Fingerprint, not authorization: actor/role come only from the verified session; isAdmin is checked separately.
  // Ordered buckets retain exact receipt counts/max IDs, detecting refund/replacement even at an unchanged net.
  // Opening history revisions likewise detect principal edits that return to the same values.
  const previewToken = createHash("sha256").update(JSON.stringify([
    "legacy-void-v1", input.actor, input.actorRole, input.mode, input.patientId, input.agreementId,
    agreement, work, existing, liveRemaining, collections, history.last_history_id, lockedBefore, impact,
  ])).digest("hex");
  return { preview: { ...impact, previewToken } satisfies LegacyVoidPreview, existing };
}

export async function getLegacyVoidPreview(input: {
  patientId: number; agreementId: number; actor: string; actorRole: string | null; mode?: LegacyVoidMode;
}): Promise<{ ok: true; preview: LegacyVoidPreview } | { ok: false; reason: LegacyVoidRefusal }> {
  if (!isAdmin(input.actorRole)) return { ok: false, reason: "void_forbidden" };
  const mode = input.mode ?? "ordinary";
  if (!isLegacyVoidMode(mode)) return { ok: false, reason: "bad_void_request" };
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [agreement] } = await client.query<VoidAgreementRow>(
      `SELECT status, currency, remaining_minor::text, opening_effect, service_name, plan_item_id
         FROM legacy_treatment_agreements WHERE id = $1 AND patient_id = $2`, [input.agreementId, input.patientId]);
    if (!agreement) throw new Refusal("not_found");
    const { preview } = await readLegacyVoidPreviewInTx(client, { ...input, mode }, agreement, false);
    await client.query("COMMIT");
    return { ok: true, preview };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Refusal) return { ok: false, reason: error.reason as LegacyVoidRefusal };
    throw error;
  } finally { client.release(); }
}

export type VoidLegacyTreatmentResult =
  | { ok: true; agreement: LegacyAgreementView }
  | { ok: false; reason: LegacyVoidRefusal };

/**
 * Admin void corrects only the opening principal through the existing engine and leaves a durable financial-review hold.
 * Ordinary mode refuses any net collection in this patient's opening currency, even when this agreement removes no principal.
 * The explicit administrator exception requires a current preview and sufficient remaining principal; never allocate receipts.
 * Agreement, canonical master, item, cases and sessions are retained.
 * No clinical signature or new invoice may turn the historical amount into a new charge while review is unresolved.
 */
export async function voidLegacyTreatment(input: {
  patientId: number; agreementId: number; reason: string; actor: string; actorRole: string | null;
  mode?: LegacyVoidMode; previewToken?: string;
}): Promise<VoidLegacyTreatmentResult> {
  // Enforce authority in the writer as well as HTTP. No caller-provided boolean can elevate a role.
  if (!isAdmin(input.actorRole)) return { ok: false, reason: "void_forbidden" };
  const parsed = parseLegacyVoidRequest({ reason: input.reason, mode: input.mode, previewToken: input.previewToken });
  if (!parsed.ok) return parsed;
  const { reason, mode, previewToken } = parsed.value;
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: [found] } = await client.query<{ plan_item_id: number }>(
      `SELECT plan_item_id FROM legacy_treatment_agreements WHERE id = $1 AND patient_id = $2`,
      [input.agreementId, input.patientId]);
    if (!found) throw new Refusal("not_found");
    // Match signatures, invoice creation and plan edits: patient -> plans -> item -> agreement.
    // The completed-session snapshot below is taken only after the patient lock wait has finished.
    await client.query(`SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE`, [input.patientId]);
    await client.query(`SELECT id FROM treatment_plans WHERE patient_id = $1 ORDER BY id FOR UPDATE`, [input.patientId]);
    const { rows: [item] } = await client.query<{ id: number; plan_id: number; status: string; service_name: string; done: string }>(
      `SELECT i.id, i.plan_id, i.status, i.service_name,
              (SELECT COUNT(*) FROM treatment_sessions s WHERE s.plan_item_id = i.id AND s.status = 'done')::text AS done
         FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
        WHERE i.id = $1 AND t.patient_id = $2 FOR UPDATE OF i`, [found.plan_item_id, input.patientId]);
    const { rows: [agreement] } = await client.query<VoidAgreementRow>(
      `SELECT status, currency, remaining_minor::text, opening_effect, service_name, plan_item_id
         FROM legacy_treatment_agreements WHERE id = $1 AND patient_id = $2 FOR UPDATE`, [input.agreementId, input.patientId]);
    if (!agreement) throw new Refusal("not_found");
    if (!item || item.id !== agreement.plan_item_id) throw new Refusal("opening_changed");
    if (agreement.status !== "live") throw new Refusal("already_void");
    // Unconditional financial check: a fully historically paid agreement has the same collection guard.
    const { preview, existing } = await readLegacyVoidPreviewInTx(client, { ...input, mode }, agreement, true);
    if (!preview.canVoid) throw new Refusal(preview.refusal!);
    // Mandatory for manager mode, optional (but binding when supplied) for ordinary mode.
    if (previewToken !== undefined && previewToken !== preview.previewToken) throw new Refusal("preview_stale");
    const currency = preview.currency;
    const remaining = Number(agreement.remaining_minor);

    let voidHistoryId: number | null = null;
    let openingAudit: AuditInput | null = null;
    if (agreement.opening_effect !== "none") {
      if (!existing) throw new Refusal("opening_changed");
      const after = preview.openingPrincipalAfterMinor;
      const why = `إبطال ${mode === "manager_authorized" ? "مصرّح به للمدير" : "عادي"} لاتفاق علاجٍ بدأ قبل النظام #${input.agreementId} — ${agreement.service_name}: ${reason}`;
      const expectedBefore = { amountMinor: existing.amountMinor, asOfDate: existing.asOfDate };
      if (after === 0) {
        voidHistoryId = await clearPatientOpeningBalanceInTx(client, input.patientId, input.actor, why, currency, expectedBefore);
        openingAudit = {
          action: "opening_balance.clear", entity: "patient", entityId: input.patientId, entityLabel: agreement.service_name,
          details: { المبلغ_المحذوف: existing.amountMinor, العملة: currency, التاريخ: existing.asOfDate, السبب: why },
          actor: input.actor, actorRole: input.actorRole,
        };
      } else {
        const saved = await setPatientOpeningBalanceInTx(client, {
          patientId: input.patientId, currency, amountMinor: after, asOfDate: existing.asOfDate, note: existing.note,
          createdBy: input.actor, reason: why, addOnly: false, expectedBefore,
        });
        voidHistoryId = saved?.historyId ?? null;
        openingAudit = {
          action: "opening_balance.set", entity: "patient", entityId: input.patientId, entityLabel: agreement.service_name,
          details: { المبلغ: after, العملة: currency, التاريخ: existing.asOfDate, المبلغ_السابق: existing.amountMinor,
            التاريخ_السابق: existing.asOfDate, السبب: why },
          actor: input.actor, actorRole: input.actorRole,
        };
      }
      if (voidHistoryId === null) throw new Refusal("opening_changed");
    }

    await client.query(
      `UPDATE legacy_treatment_agreements
          SET status = 'void', voided_by = $2, voided_at = NOW(), void_reason = $3, void_opening_history_id = $4::int
        WHERE id = $1`, [input.agreementId, input.actor, reason, voidHistoryId]);
    await client.query(
      `UPDATE plan_items SET billing_status = 'needs_financial_review' WHERE id = $1`, [item.id]);
    await audit(client, {
      action: "plan.item_update", entity: "patient", entityId: input.patientId, entityLabel: item.service_name,
      details: { البند: item.id, الرابط_المالي: "أُبطل الاتفاق التاريخي — يحتاج مراجعة مالية", الاتفاق: input.agreementId },
      actor: input.actor, actorRole: input.actorRole,
    });
    // Keep the canonical plan and all clinical records. A void is not permission to bill historical work again.
    // Other ordinary or historical items may share this master; never cancel their plan as a side effect.
    if (openingAudit) await audit(client, openingAudit);
    await audit(client, {
      action: "legacy_treatment.void", entity: "patient", entityId: input.patientId, entityLabel: agreement.service_name,
      details: {
        الاتفاق: input.agreementId, السبب: reason, العملة: currency, المتبقي_المُزال: agreement.opening_effect === "none" ? 0 : remaining,
        المراجعة_المالية: "مطلوبة قبل التوقيع أو الفوترة", السجل_السريري: "محفوظ",
        void_mode: mode, financial_impact: {
          version: preview.version, openingPrincipalBeforeMinor: preview.openingPrincipalBeforeMinor,
          removedPrincipalMinor: preview.removedPrincipalMinor, openingPrincipalAfterMinor: preview.openingPrincipalAfterMinor,
          netCollectionsMinor: preview.netCollectionsMinor, remainingDueBeforeMinor: preview.remainingDueBeforeMinor,
          remainingDueAfterMinor: preview.remainingDueAfterMinor, financialReviewRequired: true,
        }, financial_preview_fingerprint: preview.previewToken,
        السندات: "محفوظة دون تخصيص تخميني أو رد تلقائي",
      },
      actor: input.actor, actorRole: input.actorRole,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Refusal) return { ok: false, reason: error.reason as LegacyVoidRefusal };
    if (error instanceof OpeningBalanceChanged) return { ok: false, reason: "opening_changed" };
    throw error;
  } finally {
    client.release();
  }
  return { ok: true, agreement: await readAgreement(input.agreementId) };
}
