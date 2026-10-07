/**
 * (INV-LINK B) الفاتورة العلاجية ← بند الخطة ← الحالة التخصصية، في معاملةٍ واحدة.
 *
 * - البند العلاجي (خدمة دليل بفئةٍ علاجية) يرتبط ببند خطة: يُعاد استعمال بندٍ مفتوحٍ مطابق تمامًا إن وُجد،
 *   وإلا تُنشأ خطةٌ واحدة لكل فاتورة لبنودها الجديدة (بالقلب نفسه الذي ينشئ الخطط `insertPlanV2InTx`).
 * - البند المالي (بلا خدمة، أو كشف/أشعة/فئة مجهولة) يبقى فاتورةً فقط — لا يُستنتج تخصصٌ من نص.
 * - سطر الفاتورة يحمل `source_type='plan_item'` (الفهرس الفريد القائم يمنع فوترة البند مرتين)،
 *   والبند يحمل `billed_invoice_id` (رابطه المالي الحي) و`origin='invoice'`.
 * - الحالة: تُعاد الحالة المفتوحة المطابقة للنطاق والتخصص، أو تُنشأ حالةٌ أولية «تحتاج تقييمًا سريريًّا» بلا أي تفاصيل
 *   سريرية، أو يُرفض الطلب إن تعدّدت الحالات بلا اختيار. لا ortho_cases، لا نتائج عصب، لا طلب مختبر.
 * - قفل صف المريض يسلسل الطلبات المتزامنة؛ ومفتاح الإعادة يعيد الفاتورة نفسها لا فاتورةً ثانية.
 * التصميم: docs/INVOICE_FIRST_CLINICAL_LINKAGE.md.
 */
import {
  CLINIC_TIME_ZONE, PLAN_ITEM_FINANCIAL_REVIEW_SQL, PLAN_ITEM_INVOICE_LINEAGE_SQL, PLAN_ITEM_LEGACY_LINEAGE_SQL, PLAN_ITEM_LEGACY_COVERED_SQL, PLAN_ITEM_LEGACY_CONTEXT_SQL, ensureSchema, getInvoice, getPool, insertAuditRow, insertPlanV2InTx,
  type AuditInput, type DbClient, type Invoice,
} from "./db";
import { legacyCoverageOverlaps, legacyCoverageStateFromContext } from "./legacy-treatment-coverage";
import { lockClinicalDoctors } from "./clinical-doctor-identity";
import { documentNumberSql } from "./document-numbers";
import { normalizeSurfaces } from "./dental";
import type { Currency } from "./money";
import { clinicDateString } from "./schedule";
import type { SpecialtyTemplate } from "./specialty-templates";
import {
  LINKAGE_SPECIALTY_LABEL, caseSiteFits, caseSiteOverlaps, lineLinkage, scopeNote, sessionsFor, shellCaseTitleFor, siteGroupKey, siteText,
  validateLineSite, type InvoiceLinkageRefusal, type LineSite, type LinkageSpecialty,
} from "./invoice-clinical-linkage";

export interface LinkedInvoiceLineInput {
  serviceId: number | null;
  category: string | null;
  doctorId: number | null;
  description: string;
  quantity: number;
  unitPriceMinor: number;
  toothCode: number | null;
  /** حالةٌ يختارها المستخدم لهذا البند (حين للمريض أكثر من حالة مفتوحة للتخصص). */
  caseId: number | null;
  /** عدد جلسات البند إن أُعطي؛ وإلا من قالب التخصص. */
  sessions: number | null;
  /** (INV-LINK TOOTH) أسطح الحشوة كما اختيرت من المخطط (تُطبَّع). */
  surfaces?: string | null;
  /** (INV-LINK TOOTH) أسنان حلقة التاج/القشرة/الجسر كلها — سطرٌ لكل سن، وحالةٌ واحدة للحلقة. */
  episodeTeeth?: number[] | null;
  /** (INV-LINK TOOTH) نطاقٌ بلا سن: علوي/سفلي/الفكّان/كامل الفم. */
  scope?: string | null;
}

export interface LineLink {
  line: number;
  kind: "financial" | "clinical";
  specialty: LinkageSpecialty | null;
  planItemId: number | null;
  planItemCreated: boolean;
  caseId: number | null;
  caseCreated: boolean;
}

export type CreateLinkedInvoiceResult =
  | { ok: true; invoice: Invoice; replayed: boolean; planId: number | null; links: LineLink[] }
  | { ok: false; reason: InvoiceLinkageRefusal | "no_patient"; line: number | null };

class Refusal extends Error {
  constructor(readonly reason: InvoiceLinkageRefusal | "no_patient", readonly line: number | null) { super(reason); }
}

const OPEN_CASE = `status IN ('active', 'waiting')`;

interface ExistingWork {
  id: number; quantity: number; unit_price_minor: string; case_id: number | null;
  session_count: number; surfaces: string | null; doctor_id: number | null; tooth_code: number | null;
  plan_status: string; base_currency: string; status: string; started_at: Date | null;
  billing_status: string; has_invoice_lineage: boolean; has_legacy_lineage: boolean; legacy_covered: boolean; legacy_context: unknown; has_sessions: boolean; installments: boolean;
  case_site: string | null; case_status: string | null; financial_review: boolean;
}

type WorkInspection = { item: ExistingWork | null; refusal: InvoiceLinkageRefusal | null };

/** The same evidence/shape rules feed save and preview. Never erase historical work identity. */
async function inspectExistingWork(
  db: Pick<DbClient, "query">, patientId: number, currency: Currency,
  item: { serviceId: number | null; quantity: number; unitPriceMinor: number; sessions?: number | null; caseId: number | null },
  site: LineSite, claimed: readonly number[],
): Promise<WorkInspection> {
  // Match immutable patient/service identity too: current plan/item edits cannot hide historical work.
  const { rows } = await db.query<ExistingWork>(
    `SELECT i.id, i.quantity, i.unit_price_minor, i.case_id, i.session_count, i.surfaces, i.doctor_id, i.tooth_code,
       t.status AS plan_status, t.base_currency, i.status, i.started_at, i.billing_status, c.site AS case_site, c.status AS case_status, ${PLAN_ITEM_FINANCIAL_REVIEW_SQL} AS financial_review,
       (i.billed_invoice_id IS NOT NULL OR i.origin_invoice_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM invoice_items ii WHERE ii.plan_item_id = i.id OR (ii.source_type = 'plan_item' AND ii.source_id = i.id))) AS has_invoice_lineage, ${PLAN_ITEM_LEGACY_LINEAGE_SQL} AS has_legacy_lineage, ${PLAN_ITEM_LEGACY_COVERED_SQL} AS legacy_covered, ${PLAN_ITEM_LEGACY_CONTEXT_SQL} AS legacy_context,
       EXISTS (SELECT 1 FROM treatment_sessions ts WHERE ts.plan_item_id = i.id AND ts.status = 'done') AS has_sessions,
       EXISTS (SELECT 1 FROM plan_installments pi WHERE pi.plan_id = t.id) AS installments
     FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id LEFT JOIN clinical_cases c ON c.id = i.case_id
     WHERE ((t.patient_id = $1 AND i.service_id = $2) OR EXISTS (
       SELECT 1 FROM legacy_treatment_agreements legacy_identity
       WHERE legacy_identity.plan_item_id = i.id AND legacy_identity.patient_id = $1 AND legacy_identity.service_id = $2))
       AND (i.tooth_code IS NOT DISTINCT FROM $3::smallint OR i.tooth_code IS NULL OR $3::smallint IS NULL OR ${PLAN_ITEM_LEGACY_LINEAGE_SQL})
     ORDER BY i.id`, [patientId, item.serviceId, site.toothCode]);
  // Unknown case scope must be resolved rather than manufactured as a fresh item.
  const scoped = rows.filter((row) => {
    // Explicit different active case can identify a genuinely new episode after completed care.
    // A cancelled, started, or financially unresolved item is never bypassed this way.
    if (item.caseId !== null && row.case_id !== null && item.caseId !== row.case_id
      && row.status === "done" && (row.case_status === "completed" || row.case_status === "closed")
      && row.financial_review === false
      && (!row.has_legacy_lineage || legacyCoverageStateFromContext(row.legacy_context).kind === "verified")) return false;
    // Every covered member/scope, including unknown old rows, uses the immutable shared resolver.
    if (row.has_legacy_lineage) return legacyCoverageOverlaps(legacyCoverageStateFromContext(row.legacy_context), site);
    return caseSiteOverlaps(row.case_site ?? (row.tooth_code === null ? null : String(row.tooth_code)), site);
  });
  if (scoped.some((row) => claimed.includes(row.id))) return { item: null, refusal: "existing_work" };
  if (scoped.some((row) => row.financial_review || (row.has_legacy_lineage && legacyCoverageStateFromContext(row.legacy_context).kind !== "verified"))) return { item: null, refusal: "needs_financial_review" };
  if (scoped.some((row) => row.has_legacy_lineage)) return { item: null, refusal: scoped.every((row) => row.legacy_covered) ? "legacy_covered" : "needs_financial_review" };
  if (scoped.some((row) => row.billing_status === "billed")) return { item: null, refusal: "already_billed" };
  if (scoped.some((row) => row.has_invoice_lineage)) return { item: null, refusal: "needs_financial_review" };
  if (scoped.some((row) => row.status !== "planned" || row.started_at !== null || row.has_sessions || row.plan_status !== "active")) {
    return { item: null, refusal: "existing_work" };
  }
  if (scoped.some((row) => row.base_currency !== currency || row.installments || row.billing_status !== "unbilled")) {
    return { item: null, refusal: "incompatible_plan" };
  }
  if (scoped.length === 0) return { item: null, refusal: null };
  const priced = scoped.filter((row) => Number(row.unit_price_minor) === item.unitPriceMinor);
  if (priced.length === 0) return { item: null, refusal: "amount_mismatch" };
  const exact = priced.filter((row) => row.tooth_code === site.toothCode
    && (site.scope === null || row.case_site === siteText(site) || row.case_site === site.scope)
    && row.quantity === item.quantity && normalizeSurfaces(row.surfaces) === site.surfaces
    && (item.sessions == null || row.session_count === item.sessions));
  if (exact.length === 0) return { item: null, refusal: "shape_mismatch" };
  if (exact.length > 1) return { item: null, refusal: "ambiguous_item" };
  const match = exact[0];
  if (item.caseId !== null && match.case_id !== null && item.caseId !== match.case_id) return { item: null, refusal: "case_mismatch" };
  return { item: match, refusal: null };
}

/** Reclassifying a catalog service cannot erase an existing therapeutic financial identity. */
async function financialOnlyLineRefusal(
  db: Pick<DbClient, "query">, patientId: number, serviceId: number | null,
): Promise<InvoiceLinkageRefusal | null> {
  if (serviceId === null) return null;
  // A financial-only reclassification must retain the original agreement's patient and service fence.
  const { rows: existingWork } = await db.query<{
    service_id: number | null; category: string | null; has_invoice_lineage: boolean; has_legacy_lineage: boolean; legacy_covered: boolean;
  }>(
    `SELECT i.service_id, i.category, ${PLAN_ITEM_INVOICE_LINEAGE_SQL} AS has_invoice_lineage, ${PLAN_ITEM_LEGACY_LINEAGE_SQL} AS has_legacy_lineage, ${PLAN_ITEM_LEGACY_COVERED_SQL} AS legacy_covered
       FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      WHERE (t.patient_id = $1 AND i.service_id = $2) OR EXISTS (
        SELECT 1 FROM legacy_treatment_agreements legacy_identity
        WHERE legacy_identity.plan_item_id = i.id AND legacy_identity.patient_id = $1 AND legacy_identity.service_id = $2)
      ORDER BY i.id`, [patientId, serviceId]);
  const protectedWork = existingWork.some((item) => item.has_invoice_lineage || item.has_legacy_lineage
    || lineLinkage({ serviceId: item.service_id, category: item.category }).kind === "clinical");
  return protectedWork ? "needs_financial_review" : null;
}

export async function reusableMaster(db: Pick<DbClient, "query">, patientId: number, currency: Currency): Promise<number | null | false> {
  const { rows } = await db.query<{ id: number; compatible: boolean }>(
    `SELECT t.id, (t.consent_at IS NULL AND t.base_currency = $2 AND t.billing_mode = 'per_procedure'
      AND t.total_from_items AND NOT EXISTS (SELECT 1 FROM plan_installments pi WHERE pi.plan_id = t.id)) AS compatible
     FROM treatment_plans t WHERE t.patient_id = $1 AND t.status = 'active' ORDER BY t.id`, [patientId, currency]);
  if (rows.length === 0) return null;
  return rows.length === 1 && rows[0].compatible ? rows[0].id : false;
}

async function audit(client: DbClient, entry: AuditInput) { await insertAuditRow(client, entry); }

/** روابط فاتورةٍ قائمة كما كُتبت — لإعادة الطلب نفسه بلا أثرٍ ثانٍ (والخطة هي التي أنشأتها الفاتورة وحدها). */
async function existingLinks(client: Pick<DbClient, "query">, invoiceId: number): Promise<{ planId: number | null; links: LineLink[] }> {
  const { rows } = await client.query<{
    plan_item_id: number | null; case_id: number | null; service_id: number | null; category: string | null;
  }>(
    `SELECT ii.plan_item_id, i.case_id, i.service_id, i.category
       FROM invoice_items ii
       LEFT JOIN plan_items i ON i.id = ii.plan_item_id
      WHERE ii.invoice_id = $1 ORDER BY ii.id`, [invoiceId]);
  const { rows: [created] } = await client.query<{ plan_id: number }>(
    `SELECT plan_id FROM plan_items WHERE origin_invoice_id = $1 ORDER BY id LIMIT 1`, [invoiceId]);
  const links = rows.map((row, line) => {
    const linkage = lineLinkage({ serviceId: row.service_id, category: row.category });
    return {
      line, kind: row.plan_item_id === null ? "financial" as const : "clinical" as const,
      specialty: row.plan_item_id !== null && linkage.kind === "clinical" ? linkage.specialty : null,
      planItemId: row.plan_item_id, planItemCreated: false,
      caseId: row.case_id, caseCreated: false,
    };
  });
  return { planId: created?.plan_id ?? null, links };
}

export async function createLinkedInvoice(input: {
  patientId: number;
  baseCurrency: Currency;
  discountMinor: number;
  note: string | null;
  createdBy: string;
  actorRole: string | null;
  items: LinkedInvoiceLineInput[];
  templates: readonly SpecialtyTemplate[];
  idempotencyKey: string | null;
  requestHash: string | null;
  /** تفاصيل سطر تدقيق `invoice.create` (السلطة السعرية) — يُكتب داخل المعاملة نفسها. */
  auditDetails: Record<string, unknown>;
}): Promise<CreateLinkedInvoiceResult> {
  await ensureSchema();
  /* القراءة النهائية بعد تحرير اتصال المعاملة: إمساكُ اتصالٍ وطلبُ آخر تحت التزامن يستنفد المجمّع. */
  const written = await writeLinkedInvoice(input);
  if (!written.ok) return written;
  const invoice = await getInvoice(written.invoiceId);
  return { ok: true, invoice: invoice as Invoice, replayed: written.replayed, planId: written.planId, links: written.links };
}

type Written =
  | { ok: true; invoiceId: number; replayed: boolean; planId: number | null; links: LineLink[] }
  | Extract<CreateLinkedInvoiceResult, { ok: false }>;

async function writeLinkedInvoice(input: Parameters<typeof createLinkedInvoice>[0]): Promise<Written> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: patient } = await client.query(`SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE`, [input.patientId]);
    if (!patient[0]) throw new Refusal("no_patient", null);

    if (input.idempotencyKey) {
      const { rows: [prior] } = await client.query<{ id: number; idempotency_request_hash: string | null; patient_id: number }>(
        `SELECT id, idempotency_request_hash, patient_id FROM invoices WHERE idempotency_key = $1`, [input.idempotencyKey]);
      if (prior) {
        if (prior.idempotency_request_hash !== input.requestHash || prior.patient_id !== input.patientId) {
          throw new Refusal("idempotency_conflict", null);
        }
        const replay = await existingLinks(client, prior.id);
        await client.query("ROLLBACK");
        return { ok: true, invoiceId: prior.id, replayed: true, ...replay };
      }
    }

    await client.query(`SELECT id FROM treatment_plans WHERE patient_id = $1 ORDER BY id FOR UPDATE`, [input.patientId]);
    await client.query(`SELECT i.id FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
      WHERE t.patient_id = $1 ORDER BY i.id FOR UPDATE OF i`, [input.patientId]);
    const linkages = input.items.map((item) => lineLinkage({ serviceId: item.serviceId, category: item.category }));
    for (const [line, item] of input.items.entries()) {
      if (linkages[line].kind === "financial") {
        const refusal = await financialOnlyLineRefusal(client, input.patientId, item.serviceId);
        if (refusal) throw new Refusal(refusal, line);
      }
    }
    /* (INV-LINK TOOTH) موضع كل بندٍ علاجي يُتحقق قبل أي كتابة: خدمةٌ تخص سنًّا بلا سن لا تُحفظ مرتبطةً (fail closed). */
    const sites: (LineSite | null)[] = input.items.map((item, line) => {
      if (linkages[line].kind !== "clinical") return null;
      const checked = validateLineSite(item);
      if (!checked.ok) throw new Refusal(checked.reason, line);
      return checked.site;
    });

    const clinicalDoctorIds = input.items.flatMap((item, line) => linkages[line].kind === "clinical" && item.doctorId !== null ? [item.doctorId] : []);
    const doctors = await lockClinicalDoctors(client, [], clinicalDoctorIds);
    input.items.forEach((item, line) => {
      if (linkages[line].kind === "clinical" && item.doctorId !== null && !doctors.has(item.doctorId)) throw new Refusal("bad_provider", line);
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 0) {
        throw new Refusal("shape_mismatch", line);
      }
    });
    const total = input.items.reduce((sum, item) => sum + Math.max(0, item.quantity) * Math.max(0, item.unitPriceMinor), 0);
    const discount = Math.min(Math.max(0, input.discountMinor), total);
    const { rows: [created] } = await client.query<{ id: number; invoice_number: string }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, note, created_by,
                             idempotency_key, idempotency_request_hash)
       VALUES (${documentNumberSql("invoice")}, $1, $2, $3, $4, $5::text, $6, $7::text, $8::text)
       RETURNING id, invoice_number`,
      [input.patientId, total, discount, input.baseCurrency, input.note, input.createdBy,
        input.idempotencyKey, input.idempotencyKey ? input.requestHash : null]);
    const invoiceId = created.id;

    // ── بنود الخطة: مطابقٌ مفتوح يُعاد، وإلا جديدٌ في خطةٍ واحدة لهذه الفاتورة ──
    const links: LineLink[] = input.items.map((_, line) => ({
      line, kind: linkages[line].kind, specialty: linkages[line].kind === "clinical" ? (linkages[line] as { specialty: LinkageSpecialty }).specialty : null,
      planItemId: null, planItemCreated: false, caseId: null, caseCreated: false,
    }));
    const financialDoctors = input.items.map((item) => item.doctorId);
    const claimed: number[] = [];
    const fresh: number[] = [];
    const requestedWork: { serviceId: number | null; site: LineSite }[] = [];
    for (const [line, item] of input.items.entries()) {
      if (linkages[line].kind !== "clinical") continue;
      const site = sites[line]!;
      if (requestedWork.some((prior) => prior.serviceId === item.serviceId && (
        (prior.site.toothCode === site.toothCode && prior.site.scope === site.scope) || ((prior.site.scope !== null || site.scope !== null)
          && caseSiteOverlaps(siteText(prior.site), site))))) throw new Refusal("existing_work", line);
      requestedWork.push({ serviceId: item.serviceId, site });
      const inspection = await inspectExistingWork(client, input.patientId, input.baseCurrency, item, sites[line]!, claimed);
      if (inspection.refusal) throw new Refusal(inspection.refusal, line);
      const match = inspection.item;
      if (!match) { fresh.push(line); continue; }
      if (match.doctor_id !== null && item.doctorId !== null && match.doctor_id !== item.doctorId) throw new Refusal("bad_provider", line);
      financialDoctors[line] = match.doctor_id ?? item.doctorId;
      if (financialDoctors[line] !== null && !(await lockClinicalDoctors(client, [], [financialDoctors[line]])).has(financialDoctors[line]!)) {
        throw new Refusal("bad_provider", line);
      }
      claimed.push(match.id);
      links[line].planItemId = match.id;
      links[line].caseId = match.case_id;
      await client.query(
        `UPDATE plan_items SET billing_status = CASE WHEN $3::int IS NULL THEN 'needs_financial_review' ELSE 'billed' END, billed_invoice_id = $2, doctor_id = $3 WHERE id = $1`, [match.id, invoiceId, financialDoctors[line]]);
      await audit(client, {
        action: "plan.item_update", entity: "patient", entityId: input.patientId, entityLabel: item.description,
        details: { البند: match.id, الرابط_المالي: `قُبل ماليًّا بالفاتورة ${created.invoice_number}`, المصدر: "فاتورة علاجية" },
        actor: input.createdBy, actorRole: input.actorRole,
      });
    }

    let planId: number | null = null;
    if (fresh.length > 0) {
      const masterId = await reusableMaster(client, input.patientId, input.baseCurrency);
      if (masterId === false) throw new Refusal("incompatible_plan", fresh[0]);
      const specialties = [...new Set(fresh.map((line) => links[line].specialty))];
      const plan = await insertPlanV2InTx(client, {
        patientId: input.patientId,
        title: `علاج مفوتر — ${created.invoice_number}`,
        specialty: specialties.length === 1 ? specialties[0] : null,
        primaryDoctorId: null,
        billingMode: "per_procedure",
        baseCurrency: input.baseCurrency,
        startDate: clinicDateString(new Date(), CLINIC_TIME_ZONE),
        note: `أُنشئت من الفاتورة ${created.invoice_number}`,
        items: fresh.map((line) => {
          const item = input.items[line];
          return {
            serviceId: item.serviceId, serviceName: item.description, category: item.category,
            toothCode: sites[line]!.toothCode, surfaces: sites[line]!.surfaces,
            quantity: Math.max(1, Math.round(item.quantity)), unitPriceMinor: Math.round(item.unitPriceMinor),
            billingRule: "on_completion" as const,
            sessionCount: sessionsFor(item.category, item.sessions, input.templates), note: scopeNote(sites[line]!),
          };
        }),
        installments: [],
        createdBy: input.createdBy,
      }, masterId);
      if (!plan.ok) throw new Error(plan.message);
      planId = plan.planId;
      // Invoice provenance is financial acceptance only. Clinical consent is recorded solely by recordPlanConsent.
      for (const [index, line] of fresh.entries()) {
        const itemId = plan.itemIds[index];
        links[line].planItemId = itemId;
        links[line].planItemCreated = true;
        await client.query(
          `UPDATE plan_items
              SET billing_status = CASE WHEN $3::int IS NULL THEN 'needs_financial_review' ELSE 'billed' END, billed_invoice_id = $2, origin = 'invoice', origin_invoice_id = $2,
                  doctor_id = COALESCE(doctor_id, $3::int)
            WHERE id = $1`,
          [itemId, invoiceId, financialDoctors[line]]);
      }
      await audit(client, {
        action: masterId === null ? "plan.create" : "plan.item_update", entity: "patient", entityId: input.patientId, entityLabel: `علاج مفوتر — ${created.invoice_number}`,
        details: { الخطة: planId, البنود: fresh.length, المصدر: `فاتورة ${created.invoice_number}`, القبول_المالي: "سجل الفاتورة؛ الموافقة السريرية لم تُسجّل" },
        actor: input.createdBy, actorRole: input.actorRole,
      });
    }

    // ── الحالات التخصصية: حالةٌ مفتوحة واحدة تُعاد، أو أولية تُنشأ، أو رفضٌ إن تعدّدت بلا اختيار ──
    const caseBySpecialty = new Map<string, { id: number; created: boolean }>();
    for (const [line, item] of input.items.entries()) {
      const linkage = linkages[line];
      if (linkage.kind !== "clinical" || !linkage.needsCase) continue;
      const specialty = linkage.specialty;
      let caseId = links[line].caseId;
      let caseCreated = false;
      if (item.caseId !== null || caseId !== null) {
        const { rows: [chosen] } = await client.query<{ id: number; site: string | null }>(
          `SELECT id, site FROM clinical_cases WHERE id = $1 AND patient_id = $2 AND specialty = $3 AND ${OPEN_CASE}
            AND (ortho_case_id IS NULL OR EXISTS (SELECT 1 FROM ortho_cases o WHERE o.id = ortho_case_id AND o.patient_id = $2 AND o.status IN ('active', 'retention')))
            FOR UPDATE`, [item.caseId ?? caseId, input.patientId, specialty]);
        if (!chosen) throw new Refusal("bad_case", line);
        if (!caseSiteFits(specialty, chosen.site, sites[line]!)) throw new Refusal("bad_site", line);
        caseId = chosen.id;
      } else if (caseId === null) {
        const site = sites[line]!;
        const groupKey = siteGroupKey(specialty, site);
        const known = caseBySpecialty.get(groupKey);
        if (known) {
          caseId = known.id;
        } else {
          /* حالةٌ مفتوحة للتخصص تُعاد فقط إن وافق موضعُها سنَّ البند (للتخصص الموضعي): علاج عصب 36 لا يُلحق بحالة 11. */
          const { rows: sameSpecialty } = await client.query<{ id: number; site: string | null }>(
            `SELECT id, site FROM clinical_cases WHERE patient_id = $1 AND specialty = $2 AND ${OPEN_CASE}
              AND (ortho_case_id IS NULL OR EXISTS (SELECT 1 FROM ortho_cases o WHERE o.id = ortho_case_id AND o.patient_id = $1 AND o.status IN ('active', 'retention')))
              ORDER BY id FOR UPDATE`,
            [input.patientId, specialty]);
          if (sameSpecialty.some((row) => !(row.site ?? "").trim())) throw new Refusal("bad_site", line);
          const open = sameSpecialty.filter((row) => caseSiteFits(specialty, row.site, site));
          if (open.length > 1) throw new Refusal("ambiguous_case", line);
          if (open.length === 1) {
            caseId = open[0].id;
          } else {
            // التقويم: حالة تقويمٍ جارية غير مجسورة تُجسَر — لا حالةٌ ثانية للمريض نفسه.
            let orthoCaseId: number | null = null;
            if (specialty === "orthodontics") {
              const { rows: orthos } = await client.query<{ id: number; arches: string }>(
                `SELECT o.id, o.arches FROM ortho_cases o
                  WHERE o.patient_id = $1 AND o.status IN ('active', 'retention')
                    AND NOT EXISTS (SELECT 1 FROM clinical_cases c WHERE c.ortho_case_id = o.id)
                  ORDER BY o.id FOR UPDATE`, [input.patientId]);
              if (orthos.length > 1) throw new Refusal("ambiguous_case", line);
              if (orthos.length === 1 && orthos[0].arches !== site.scope) throw new Refusal("bad_site", line);
              orthoCaseId = orthos[0]?.id ?? null;
            }
            const title = orthoCaseId !== null ? "تقويم الأسنان" : shellCaseTitleFor(specialty, site);
            const { rows: [shell] } = await client.query<{ id: number }>(
              `INSERT INTO clinical_cases (patient_id, specialty, title, site, ortho_case_id, created_by, origin, origin_invoice_id)
               VALUES ($1, $2, $3, $4::text, $5::int, $6, 'invoice', $7) RETURNING id`,
              [input.patientId, specialty, title, siteText(site), orthoCaseId,
                input.createdBy, invoiceId]);
            caseId = shell.id;
            caseCreated = true;
            await audit(client, {
              action: "case.create", entity: "patient", entityId: input.patientId, entityLabel: title,
              details: {
                الحالة: shell.id, التخصص: LINKAGE_SPECIALTY_LABEL[specialty], المصدر: `فاتورة ${created.invoice_number}`,
                جسر_التقويم: orthoCaseId ?? "—", وضع_الحالة: orthoCaseId !== null ? "حالة تقويم قائمة" : "تحتاج تقييمًا سريريًّا",
              },
              actor: input.createdBy, actorRole: input.actorRole,
            });
          }
          caseBySpecialty.set(groupKey, { id: caseId, created: caseCreated });
        }
      }
      links[line].caseId = caseId;
      links[line].caseCreated = caseCreated;
      const { rowCount } = await client.query(
        `UPDATE plan_items SET case_id = $2 WHERE id = $1 AND case_id IS NULL`, [links[line].planItemId, caseId]);
      if ((rowCount ?? 0) > 0) {
        await audit(client, {
          action: "plan.item_case", entity: "patient", entityId: input.patientId, entityLabel: item.description,
          details: { البند: links[line].planItemId, الحالة: caseId, المصدر: `فاتورة ${created.invoice_number}` },
          actor: input.createdBy, actorRole: input.actorRole,
        });
      }
    }

    for (const [line, item] of input.items.entries()) {
      const quantity = Math.max(1, Math.round(item.quantity));
      const unit = Math.max(0, Math.round(item.unitPriceMinor));
      const source = links[line].planItemId;
      await client.query(
        `INSERT INTO invoice_items (invoice_id, service_id, doctor_id, description, quantity, unit_price_minor, total_minor,
                                    source_type, source_id, plan_item_id)
         VALUES ($1, $2::int, $3::int, $4, $5, $6, $7, $8::text, $9::bigint, $10::int)`,
        [invoiceId, item.serviceId, financialDoctors[line], item.description, quantity, unit, quantity * unit,
          source === null ? null : "plan_item", source, source]);
    }

    const clinical = links.filter((link) => link.kind === "clinical");
    await audit(client, {
      action: "invoice.create", entity: "invoice", entityId: invoiceId, entityLabel: created.invoice_number,
      details: {
        المريض: input.patientId, الإجمالي: total, الخصم: discount, عدد_البنود: input.items.length,
        ...input.auditDetails,
        ...(clinical.length ? {
          الربط_بالعلاج: clinical.map((link) =>
            `${LINKAGE_SPECIALTY_LABEL[link.specialty!]}: بند ${link.planItemId}${link.planItemCreated ? " (جديد)" : " (قائم)"}`
            + (link.caseId ? ` · حالة ${link.caseId}${link.caseCreated ? " (أولية)" : ""}` : "")).join(" | "),
        } : {}),
      },
      actor: input.createdBy, actorRole: input.actorRole,
    });
    await client.query("COMMIT");
    return { ok: true, invoiceId, replayed: false, planId, links };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Refusal) return { ok: false, reason: error.reason, line: error.line };
    // مفتاحٌ واحد لطلبين متزامنين لمريضين مختلفين: الفهرس الفريد يحسم — تعارضٌ لا فاتورة ثانية.
    if ((error as { code?: string; constraint?: string }).code === "23505"
      && (error as { constraint?: string }).constraint === "invoices_idempotency_key_uniq") {
      return { ok: false, reason: "idempotency_conflict", line: null };
    }
    throw error;
  } finally {
    client.release();
  }
}

// ─── المعاينة (قراءة فقط) ─────────────────────────────────────────────────────

export interface LinePreview {
  line: number;
  kind: "financial" | "clinical";
  specialty: LinkageSpecialty | null;
  specialtyLabel: string | null;
  /** بند الخطة: قائمٌ مطابق يُعاد، أو جديد. */
  item: { mode: "existing" | "new"; id: number | null } | null;
  /** الحالة: قائمة تُربط، أو أولية تُنشأ، أو جسرٌ لحالة تقويم قائمة، أو يلزم الاختيار، أو لا حاجة. */
  case: { mode: "existing" | "new" | "bridge" | "choose" | "none"; id: number | null; title: string | null;
    options: { id: number; title: string }[] } | null;
  /** سبب رفضٍ متوقَّع (المعاينة تحذّر؛ الحفظ يرفض فعلًا). */
  refusal: InvoiceLinkageRefusal | null;
  financialReviewRequired?: boolean;
}

/**
 * ماذا ستفعل الفاتورة بالعلاج — قبل الحفظ. قراءةٌ بلا أقفال ولا كتابة، بالقواعد نفسها التي يطبّقها
 * `createLinkedInvoice` (والحفظ يعيد الفحص تحت القفل؛ المعاينة ليست وعدًا).
 */
export async function previewInvoiceLinkage(input: {
  patientId: number; baseCurrency: Currency;
  items: { serviceId: number | null; category: string | null; quantity: number; unitPriceMinor: number;
    toothCode: number | null; caseId: number | null; sessions?: number | null;
    surfaces?: string | null; episodeTeeth?: number[] | null; scope?: string | null; doctorId?: number | null }[];
}): Promise<LinePreview[]> {
  await ensureSchema();
  const pool = getPool();
  const claimed: number[] = [];
  const newCaseForGroup = new Set<string>();
  const previews: LinePreview[] = [];
  const requestedWork: { serviceId: number | null; site: LineSite }[] = [];
  for (const [line, item] of input.items.entries()) {
    const linkage = lineLinkage({ serviceId: item.serviceId, category: item.category });
    if (linkage.kind !== "clinical") {
      const refusal = await financialOnlyLineRefusal(pool, input.patientId, item.serviceId);
      previews.push({ line, kind: "financial", specialty: null, specialtyLabel: null, item: null, case: null,
        refusal, financialReviewRequired: refusal !== null });
      continue;
    }
    const preview: LinePreview = {
      line, kind: "clinical", specialty: linkage.specialty, specialtyLabel: LINKAGE_SPECIALTY_LABEL[linkage.specialty],
      item: { mode: "new", id: null }, case: linkage.needsCase ? null : { mode: "none", id: null, title: null, options: [] },
      refusal: null,
    };
    const checked = validateLineSite(item);
    if (!checked.ok) { preview.refusal = checked.reason; previews.push(preview); continue; }
    const site = checked.site;
    if (requestedWork.some((prior) => prior.serviceId === item.serviceId && (
      (prior.site.toothCode === site.toothCode && prior.site.scope === site.scope) || ((prior.site.scope !== null || site.scope !== null)
        && caseSiteOverlaps(siteText(prior.site), site))))) preview.refusal = "existing_work";
    requestedWork.push({ serviceId: item.serviceId, site });
    const { rows: [doctor] } = await pool.query(`SELECT id FROM parties WHERE id = $1 AND kind = 'doctor'`, [item.doctorId ?? null]);
    if (item.doctorId != null && !doctor) preview.refusal = "bad_provider";
    preview.financialReviewRequired = item.doctorId == null;
    const inspected = await inspectExistingWork(pool, input.patientId, input.baseCurrency, item, site, claimed);
    preview.refusal = inspected.refusal ?? preview.refusal;
    const match = inspected.item;
    let linkedCase: number | null = null;
    if (match) {
      if (match.doctor_id !== null && item.doctorId != null && item.doctorId !== match.doctor_id) preview.refusal = "bad_provider";
      preview.financialReviewRequired = (match.doctor_id ?? item.doctorId) == null;
      if (match.doctor_id !== null) {
        const { rows: [assigned] } = await pool.query(`SELECT id FROM parties WHERE id = $1 AND kind = 'doctor'`, [match.doctor_id]);
        if (!assigned) preview.refusal = "bad_provider";
      }
      claimed.push(match.id);
      preview.item = { mode: "existing", id: match.id };
      linkedCase = match.case_id;
    } else if (!preview.refusal && await reusableMaster(pool, input.patientId, input.baseCurrency) === false) {
      preview.refusal = "incompatible_plan";
    }
    if (linkage.needsCase) {
      const { rows: sameSpecialty } = await pool.query<{ id: number; title: string; site: string | null }>(
        `SELECT id, title, site FROM clinical_cases WHERE patient_id = $1 AND specialty = $2 AND ${OPEN_CASE}
          AND (ortho_case_id IS NULL OR EXISTS (SELECT 1 FROM ortho_cases o WHERE o.id = ortho_case_id AND o.patient_id = $1 AND o.status IN ('active', 'retention')))
          ORDER BY id`,
        [input.patientId, linkage.specialty]);
      if (item.caseId === null && linkedCase === null && sameSpecialty.some((row) => !(row.site ?? "").trim())) {
        preview.refusal = preview.refusal ?? "bad_site";
      }
      // Explicit, inherited, and automatic choices all require exact patient/specialty/site/lifecycle compatibility.
      const all = sameSpecialty.map(({ id, title }) => ({ id, title }));
      const open = sameSpecialty.filter((row) => caseSiteFits(linkage.specialty, row.site, site))
        .map(({ id, title }) => ({ id, title }));
      const groupKey = siteGroupKey(linkage.specialty, site);
      if (item.caseId !== null) {
        const chosen = open.find((one) => one.id === item.caseId);
        preview.case = chosen ? { mode: "existing", id: chosen.id, title: chosen.title, options: open.length > 1 ? open : all }
          : { mode: "choose", id: null, title: null, options: open.length > 0 ? open : all };
        if (!chosen) preview.refusal = preview.refusal ?? (all.some((one) => one.id === item.caseId) ? "bad_site" : "bad_case");
      } else if (linkedCase !== null) {
        const found = open.find((one) => one.id === linkedCase);
        if (!found) preview.refusal = preview.refusal ?? "bad_case";
        preview.case = { mode: "existing", id: linkedCase, title: found?.title ?? null, options: [] };
      } else if (newCaseForGroup.has(groupKey)) {
        preview.case = { mode: "new", id: null, title: shellCaseTitleFor(linkage.specialty, site), options: [] };
      } else if (open.length > 1) {
        preview.case = { mode: "choose", id: null, title: null, options: open };
        preview.refusal = preview.refusal ?? "ambiguous_case";
      } else if (open.length === 1) {
        preview.case = { mode: "existing", id: open[0].id, title: open[0].title, options: [] };
      } else {
        if (sameSpecialty.some((row) => !(row.site ?? "").trim())) preview.refusal = preview.refusal ?? "bad_site";
        let bridge = false;
        if (linkage.specialty === "orthodontics") {
          const { rows: orthos } = await pool.query<{ arches: string }>(
            `SELECT o.arches FROM ortho_cases o WHERE o.patient_id = $1 AND o.status IN ('active', 'retention')
                AND NOT EXISTS (SELECT 1 FROM clinical_cases c WHERE c.ortho_case_id = o.id) ORDER BY o.id`, [input.patientId]);
          if (orthos.length > 1) preview.refusal = preview.refusal ?? "ambiguous_case";
          if (orthos.length === 1 && orthos[0].arches !== site.scope) preview.refusal = preview.refusal ?? "bad_site";
          bridge = orthos.length === 1;
        }
        newCaseForGroup.add(groupKey);
        preview.case = bridge
          ? { mode: "bridge", id: null, title: "تقويم الأسنان", options: [] }
          : { mode: "new", id: null, title: shellCaseTitleFor(linkage.specialty, site), options: [] };
      }
    }
    previews.push(preview);
  }
  return previews;
}

