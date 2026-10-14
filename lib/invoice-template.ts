/** Server-only template expansion for the canonical invoice save/preview boundary. */
import { createHash } from "node:crypto";
import type { Service } from "./db";
import { isValidTooth, MAX_SELECTED_TEETH } from "./dental";
import { INVOICE_IDEMPOTENCY_PATTERN, invoiceRequestFingerprint, lineLinkage, parseLineSiteFields, toothScope, validateLineSite } from "./invoice-clinical-linkage";
import { parseInvoiceInput, type ParsedInvoiceInput } from "./invoice-input";
import { CLINIC_BASE_CURRENCY, isCurrency, toInputAmount } from "./money";
import { foreignRatesFromSettings } from "./service-pricing";
import { buildTemplateDrafts, effectiveTemplates, type TemplatePlanDraft } from "./specialty-templates";
import { validateDebtRepaymentTerms, type DebtRepaymentTerms } from "./debt-installments";

export type InvoiceTemplateSelection = {
  templateId: string; version?: string; teeth: number[];
  steps: { key: string; include: boolean; serviceId: number | null }[];
  doctorId: number | null;
  sites?: { stepKey: string; toothCode: number | null; scope?: string | null;
    episodeTeeth?: number[] | null; surfaces?: string | null; caseId?: number | null }[];
};

export type InvoiceTemplatePreviewLine = {
  line: number; stepKey: string; serviceId: number; description: string; quantity: number; unitPriceMinor: number;
  toothCode: number | null; scope: string | null; episodeTeeth: number[] | null; surfaces: string | null;
  caseId: number | null; doctorId: number | null; sessions: number; sessionPlan: TemplatePlanDraft["sessions"];
};
export type InvoiceTemplatePreview = { templateId: string; version: string; lines: InvoiceTemplatePreviewLine[] };
type Failure = { ok: false; status: 400 | 409; code: "INVOICE_TEMPLATE_INVALID" | "INVOICE_TEMPLATE_REVIEW_REQUIRED" | "INVOICE_TEMPLATE_STALE"; message: string };
type Success = { ok: true; template: InvoiceTemplatePreview | null; repaymentTerms?: DebtRepaymentTerms } & ParsedInvoiceInput;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
const safeKey = (value: string): boolean => value !== "prototype" && !Object.hasOwn(Object.prototype, value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const invalid = (message = "اختيار قالب الفاتورة غير صالح."): Failure => ({ ok: false, status: 400, code: "INVOICE_TEMPLATE_INVALID", message });
function withRepayment(source: Record<string,unknown>, parsed: Success): Success | Failure {
  if (!Object.hasOwn(source,"repaymentTerms")) return parsed;
  if (!parsed.idempotencyKey) return invalid("مفتاح الطلب إلزامي لحفظ الاتفاق وطريقة سداده معًا.");
  const remaining = parsed.items.reduce((sum,item)=>sum+item.quantity*item.unitPriceMinor,0)-parsed.discountMinor;
  const terms=validateDebtRepaymentTerms(source.repaymentTerms,remaining);
  return terms.ok ? {...parsed,repaymentTerms:terms.value} : invalid(terms.message);
}

/** Clients provide selection only. No raw templatePlan, price, schedule or billing flag reaches the writer. */
export function parseInvoiceCommand(
  source: Record<string, unknown>, services: ReadonlyMap<number, Service>, doctors: ReadonlySet<number>,
  settings: Parameters<typeof foreignRatesFromSettings>[0], requireVersion: boolean,
): Success | Failure | { ok: false; message: string; status?: undefined; code?: undefined } {
  if (!object(source)) return invalid();
  if (!Object.hasOwn(source, "templateSelection") || source.templateSelection == null) {
    const parsed = parseInvoiceInput(source, services, doctors);
    return parsed.ok ? withRepayment(source,{ ...parsed, template: null }) : parsed;
  }
  const selection = source.templateSelection;
  if (Object.keys(source).some((key) => !safeKey(key))) return invalid();
  if (!object(selection) || !exactKeys(selection, ["templateId", "version", "teeth", "steps", "doctorId", "sites"])) return invalid();
  if (typeof selection.templateId !== "string" || !/^[a-z0-9_-]{1,40}$/.test(selection.templateId) || !safeKey(selection.templateId)) return invalid();
  if (selection.version !== undefined && (typeof selection.version !== "string" || !/^[a-f0-9]{64}$/.test(selection.version))) return invalid();
  if (requireVersion && (typeof source.idempotencyKey !== "string" || !INVOICE_IDEMPOTENCY_PATTERN.test(source.idempotencyKey.trim()))) return invalid("مفتاح الطلب الأصلي إلزامي لحفظ فاتورة القالب واستعادة نتيجتها.");
  if (!Array.isArray(selection.teeth) || selection.teeth.length > MAX_SELECTED_TEETH
    || selection.teeth.some((tooth) => typeof tooth !== "number" || !isValidTooth(tooth))) return invalid("اختر أسنانًا صحيحة ضمن الحد المسموح.");
  const teeth = [...new Set(selection.teeth as number[])].sort((a, b) => a - b);
  if (!Array.isArray(selection.steps) || selection.steps.length > 20) return invalid();
  const template = effectiveTemplates(settings["plans.specialty_templates"]).templates.find((one) => one.id === selection.templateId);
  if (!template) return invalid("قالب العلاج غير موجود؛ أعد اختيار القالب الحالي.");
  const steps: { key: string; include: boolean; serviceId: number | null }[] = [];
  const seenSteps = new Set<string>();
  for (const raw of selection.steps) {
    if (!object(raw) || !exactKeys(raw, ["key", "include", "serviceId"]) || typeof raw.key !== "string"
      || !safeKey(raw.key) || typeof raw.include !== "boolean" || (raw.serviceId !== null && !id(raw.serviceId)) || seenSteps.has(raw.key)) return invalid();
    const step = template.steps.find((one) => one.key === raw.key);
    if (!step || (!step.optional && !raw.include)) return invalid("خطوة القالب غير معروفة أو لازمة ولا يمكن حذفها.");
    seenSteps.add(raw.key);
    steps.push({ key: raw.key, include: raw.include, serviceId: raw.serviceId as number | null });
  }
  const doctorId = selection.doctorId;
  if (doctorId !== null && (!id(doctorId) || !doctors.has(doctorId))) return invalid("الطبيب المختار غير مسجّل.");
  // Explicit service references make catalogue inserts irrelevant to this command.
  // The UI chooses the displayed default; the server never silently switches it.
  for (const step of template.steps) {
    const choice = steps.find((one) => one.key === step.key);
    if ((!step.optional || choice?.include === true) && !id(choice?.serviceId)) return invalid("حدّد خدمة الدليل لكل خطوة مختارة.");
  }
  if (source.currency !== undefined && source.currency !== null && source.currency !== "" && !isCurrency(source.currency)) return invalid("عملة الفاتورة غير صالحة.");
  const currency = isCurrency(source.currency) ? source.currency : CLINIC_BASE_CURRENCY;
  // An invoice agreement requires prices in its own currency; FX suggestions
  // remain available to visit workflows but cannot silently price this agreement.
  const built = buildTemplateDrafts(template, { teeth, steps }, [...services.values()], currency, {});
  if (!built.ok) return invalid(built.message);
  const manual = source.items === undefined ? [] : source.items;
  if (!Array.isArray(manual) || manual.length + built.drafts.length > 40) return invalid("عدد بنود الفاتورة مع القالب يجب ألا يتجاوز ٤٠.");
  const rawSites = selection.sites === undefined ? [] : selection.sites;
  if (!Array.isArray(rawSites) || rawSites.length > 40) return invalid();
  const siteChoices = new Map<string, Record<string, unknown>>();
  for (const raw of rawSites) {
    if (!object(raw) || !exactKeys(raw, ["stepKey", "toothCode", "scope", "episodeTeeth", "surfaces", "caseId"])
      || typeof raw.stepKey !== "string" || !safeKey(raw.stepKey) || (raw.toothCode !== null && (typeof raw.toothCode !== "number" || !isValidTooth(raw.toothCode)))
      || (raw.caseId !== undefined && raw.caseId !== null && !id(raw.caseId))) return invalid();
    const key = JSON.stringify([raw.stepKey, raw.toothCode]);
    if (siteChoices.has(key)) return invalid("تكرر موضع خطوة القالب.");
    siteChoices.set(key, raw);
  }
  const generated: Record<string, unknown>[] = [];
  const lines: InvoiceTemplatePreviewLine[] = [];
  const schedules: TemplatePlanDraft[] = [];
  let draftIndex = 0;
  for (const step of template.steps) {
    const choice = steps.find((one) => one.key === step.key);
    if (step.optional && choice?.include !== true) continue;
    for (const toothCode of step.perTooth ? teeth : [null]) {
      const builtDraft = built.drafts[draftIndex++];
      if (!builtDraft || builtDraft.toothCode !== toothCode || builtDraft.category !== step.category) return invalid();
      const draft = { ...builtDraft, sessions: builtDraft.sessions.map((session) => ({ ...session, visitTitle: session.visitTitle.slice(0, 200) })) };
      const key = JSON.stringify([step.key, toothCode]);
      const rawSite = siteChoices.get(key) ?? {};
      siteChoices.delete(key);
      const fields = parseLineSiteFields(rawSite);
      if (!fields) return invalid("موضع خطوة القالب غير صالح.");
      // Prosthetic grouping is a clinical selection, never guessed from the template name.
      if (toothScope(draft.category) === "multi_tooth_episode" && (!fields.episodeTeeth || fields.episodeTeeth.length === 0)) return invalid("حدّد أسنان حلقة التركيبات صراحةً.");
      const checked = validateLineSite({ category: draft.category, toothCode, ...fields });
      if (!checked.ok) return invalid("حدّد موضع خطوة القالب بما يوافق الخدمة: السن أو الأسنان أو نطاق الفك.");
      const site = checked.site;
      const caseId = typeof rawSite.caseId === "number" ? rawSite.caseId : null;
      const linkage = lineLinkage({ serviceId: draft.serviceId, category: draft.category });
      if (caseId !== null && (linkage.kind === "financial" || !linkage.needsCase)) return invalid("هذه الخطوة لا تُربط بحالة تخصصية.");
      const line = manual.length + lines.length;
      lines.push({ line, stepKey: step.key, serviceId: draft.serviceId, description: draft.serviceName,
        quantity: 1, unitPriceMinor: draft.unitPriceMinor, toothCode: site.toothCode, scope: site.scope,
        episodeTeeth: site.episodeTeeth, surfaces: site.surfaces, caseId, doctorId: doctorId as number | null,
        sessions: draft.sessions.length, sessionPlan: draft.sessions.map((session) => ({ ...session })),
      });
      generated.push({ serviceId: draft.serviceId, quantity: 1, price: toInputAmount(draft.unitPriceMinor, currency),
        doctorId, toothCode: site.toothCode, scope: site.scope, episodeTeeth: site.episodeTeeth, surfaces: site.surfaces,
        caseId, sessions: draft.sessions.length,
      });
      schedules.push(draft);
    }
  }
  if (siteChoices.size > 0 || draftIndex !== built.drafts.length) return invalid("يوجد موضع لخطوة غير مختارة في القالب.");
  const version = createHash("sha256").update(JSON.stringify([
    template, currency, teeth, doctorId,
    lines.map(({ line: _line, ...one }) => { void _line; return one; }),
  ])).digest("hex");
  if (requireVersion && selection.version === undefined) return { ok: false, status: 409, code: "INVOICE_TEMPLATE_REVIEW_REQUIRED", message: "عاين بنود القالب ومبلغه وجدول جلساته قبل حفظ الفاتورة." };
  if (selection.version !== undefined && selection.version !== version) return { ok: false, status: 409, code: "INVOICE_TEMPLATE_STALE", message: "تغيّر القالب أو سعره أو اختياره منذ المعاينة؛ راجع المعاينة الجديدة قبل الحفظ." };
  const parsed = parseInvoiceInput({ ...source, items: [...manual, ...generated] }, services, doctors);
  if (!parsed.ok) return parsed;
  for (const [index, draft] of schedules.entries()) {
    const line = manual.length + index;
    parsed.items[line].templatePlan = { templateId: template.id, version, stepKey: lines[index].stepKey,
      billingRule: draft.billingRule, sessionPlan: draft.sessions.map((session) => ({ ...session })),
    };
    // These are authoritative catalogue values, never user overrides.
    parsed.authorityLines[line].explicit = false;
  }
  return withRepayment(source,{ ...parsed, template: { templateId: template.id, version, lines } });
}

/** Ordinary historical fingerprints remain exact; template commands bind their reviewed version and schedule. */
export function invoiceCommandFingerprint(parsed: ParsedInvoiceInput & { template: InvoiceTemplatePreview | null; repaymentTerms?: DebtRepaymentTerms }): string {
  const original = invoiceRequestFingerprint({ ...parsed, currency: parsed.baseCurrency });
  const scoped=parsed.visitId!==undefined?JSON.stringify([original,{visitId:parsed.visitId}]):original;
  const financial = parsed.repaymentTerms ? JSON.stringify([scoped,parsed.repaymentTerms]) : scoped;
  return parsed.template === null ? financial : JSON.stringify([financial, { templateId: parsed.template.templateId,
    version: parsed.template.version, lines: parsed.template.lines.map((line) => [line.line, line.stepKey, line.sessionPlan]),
  }]);
}

/** Immutable submitted intent, independent of later catalogue changes; bound to the authenticated actor. */
export function invoiceTemplateRequestFingerprint(source: Record<string, unknown>, actor: { username: string; role: string; userId?: number | null }): string {
  return invoiceIntentFingerprint(source, actor, "invoice-template-intent-v1:");
}

/** Quoted manual entries can recover an acknowledged command after catalogue drift.
 * Older unquoted API clients retain their existing canonical fingerprint contract. */
export function hasInvoiceCatalogQuote(source: Record<string, unknown>): boolean {
  return source.visitId!=null || Object.hasOwn(source,"repaymentTerms") || Array.isArray(source.items) && source.items.some(item => item !== null && typeof item === "object"
    && !Array.isArray(item) && Object.hasOwn(item, "catalogPriceMinor"));
}

export function invoiceCatalogRequestFingerprint(source: Record<string, unknown>, actor: { username: string; role: string; userId?: number | null }): string {
  return invoiceIntentFingerprint(source, actor, "invoice-catalogue-intent-v1:");
}

function invoiceIntentFingerprint(source: Record<string, unknown>, actor: { username: string; role: string; userId?: number | null }, prefix: string): string {
  const canonical = (value: unknown, depth = 0): unknown => {
    if (depth > 40) throw new Error("Invoice intent nesting exceeds the bounded command depth");
    if (Array.isArray(value)) return ["array", value.map((item) => canonical(item, depth + 1))];
    if (value !== null && typeof value === "object") return ["object", Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key], depth + 1)])];
    return [value === null ? "null" : typeof value, value];
  };
  const body = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "idempotencyKey"));
  return prefix + createHash("sha256").update(JSON.stringify([actor.userId ?? null, actor.username, actor.role, canonical(body)])).digest("hex");
}
