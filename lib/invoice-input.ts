import { parseLabWorkDraft, normalizeLabWorkGroups, type LabWorkRetirement } from "./lab-work-intent-contract";
import type { Service } from "./db";
import type { LinkedInvoiceLineInput } from "./invoice-linkage-db";
import type { InvoiceLineAuthorityInput } from "./invoice-pricing";
import { INVOICE_IDEMPOTENCY_PATTERN, parseLineSiteFields } from "./invoice-clinical-linkage";
import { CLINIC_BASE_CURRENCY, isCurrency, parseAmount, type Currency } from "./money";
import { invoiceCatalogPrice } from "./invoice-catalog-price";
import { invoicePriceQuote, sameInvoicePriceQuote, INVOICE_ZERO_CONVERSION_MESSAGE, type InvoicePriceQuote } from "./invoice-price-quote";
import type { ForeignRates } from "./service-pricing";

export type ParsedInvoiceInput = {
  visitId?:number;
  labRetirements?: LabWorkRetirement[];
  patientId: number; baseCurrency: Currency; existingPlanId: number | null; items: LinkedInvoiceLineInput[];
  authorityLines: InvoiceLineAuthorityInput[]; discountMinor: number; note: string | null; idempotencyKey: string | null;
  pricingSnapshots: { line: number; serviceId: number; quote: InvoicePriceQuote; requestedMinor: number; reason: string | null; agreedPriceSource: "catalog" | "converted" | "manual" }[];
  quotedFingerprint?: string;
};

/** Shared save/preview parsing. Optional null provider is unresolved, never an invented assignment. */
export function parseInvoiceInput(
  source: Record<string, unknown>, services: ReadonlyMap<number, Service>, doctors: ReadonlySet<number>,
  rates: ForeignRates = {},
): ({ ok: true } & ParsedInvoiceInput) | { ok: false; message: string; status?:409; code?:"INVOICE_PRICE_STALE" } {
  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return { ok: false, message: "اختر المريض أولًا." };
  }

  /* (TD-05) عملة الفاتورة من الطلب — YER/SAR/USD بحسب اتفاق المريض،
     والافتراضي هو العملة الأساسية. وعملةٌ غير معروفة تُرفض لا تُبدَّل بصمت. */
  if (source.currency !== undefined && source.currency !== null
    && String(source.currency).trim() !== "" && !isCurrency(source.currency)) {
    return { ok: false, message: "عملة الفاتورة يجب أن تكون YER أو SAR أو USD." };
  }
  const base = isCurrency(source.currency) ? source.currency : CLINIC_BASE_CURRENCY;
  // Selections are exact identities, not coercible booleans/arrays or a hint to create replacement work.
  const selectedId = (value: unknown): number | null | undefined => value === undefined || value === null
    ? null : typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : undefined;
  const existingPlanId = selectedId(source.existingPlanId);
  if (existingPlanId === undefined) return { ok: false, message: "الخطة المختارة غير صالحة." };
  const visitId=selectedId(source.visitId);
  if(visitId===undefined)return {ok:false,message:"سياق الزيارة يحتاج معرّفًا صريحًا صالحًا."};

  const rawItems = Array.isArray(source.items) ? source.items : [];
  if (rawItems.length === 0 || rawItems.length > 40) {
    return { ok: false, message: "أضف بندًا واحدًا على الأقل." };
  }

  /* (INV-LINK B) مفتاح الإعادة: نقرةٌ مزدوجة أو ردٌّ ضائع يعيد الفاتورة نفسها لا فاتورةً ثانية. */
  const idempotencyKey = typeof source.idempotencyKey === "string" && source.idempotencyKey.trim()
    ? source.idempotencyKey.trim() : null;
  if (idempotencyKey !== null && !INVOICE_IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    return { ok: false, message: "مفتاح الطلب غير صالح." };
  }
  if(visitId!==null&&!idempotencyKey)return {ok:false,message:"مفتاح الطلب مطلوب لحفظ رابط الفاتورة بالزيارة وإعادة التحقق منه."};

  const items: LinkedInvoiceLineInput[] = [];
  /* (FIN-4) ما تحتاجه سلطة السعر لكل بند: خدمة الدليل، وهل كُتب السعر، وسببه. */
  const authorityLines: InvoiceLineAuthorityInput[] = [];
  const pricingSnapshots: ParsedInvoiceInput["pricingSnapshots"] = [];
  const quoted: unknown[] = [];
  for (const value of rawItems) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "بيانات بند الفاتورة غير صالحة." };
    const raw = value as Record<string, unknown>;
    const quantity = Math.max(1, Math.round(Number(raw.quantity ?? 1)));
    if (!Number.isFinite(quantity) || quantity > 999) {
      return { ok: false, message: "الكمية غير منطقية." };
    }

    const serviceId = Number(raw.serviceId);
    const service = Number.isInteger(serviceId) ? services.get(serviceId) : undefined;
    if (raw.serviceId !== undefined && raw.serviceId !== null && raw.serviceId !== "" && (!service || !service.isActive)) {
      return { ok: false, message: "الخدمة المختارة غير متاحة؛ اختر خدمة نشطة من الدليل." };
    }
    if (service && Object.hasOwn(raw, "catalogPriceMinor") && raw.catalogPriceMinor !== invoiceCatalogPrice(service, base)) {
      return { ok: false, message: "تغيّر سعر الخدمة منذ اختيارها؛ أعد تحميل الدليل وراجع قيمة الاتفاق قبل الحفظ." };
    }
    const quote = service ? invoicePriceQuote(service, base, rates) : null;
    if (Object.hasOwn(raw, "priceQuote")) {
      if (!quote || !sameInvoicePriceQuote(raw.priceQuote, quote)) return { ok: false, status:409, code:"INVOICE_PRICE_STALE", message: "تغيّر مصدر السعر أو سعر الصرف منذ الاختيار؛ حدّث دليل الخدمات وراجع السعر قبل الحفظ." };
      quoted.push([items.length, quote]);
    }

    const description = service
      ? service.name
      : typeof raw.description === "string" ? raw.description.trim().slice(0, 160) : "";
    if (!description) {
      return { ok: false, message: "اكتب وصف البند." };
    }

    const priceRaw = raw.price;
    let unitPriceMinor: number | null;
    if (priceRaw === undefined || String(priceRaw).trim() === "") {
      /* (TD-05 owner review — Finding 3) سقوط سعر الدليل مسموحٌ للفاتورة
       * الأساسية وحدها — فاتورةُ عملة اتفاق (SAR/USD) بلا سعرٍ صريحٍ بعملتها
       * تُرفض بوضوح: سعر الدليل يمنيّ، ونسخه إليها فسادٌ مالي صامت. الحماية
       * في الخادم لا في الواجهة — فالمسار المباشر لا يمرّ بواجهة أصلًا. */
      if (base !== CLINIC_BASE_CURRENCY) {
        return { ok: false, message: `سعر البند «${description}» بعملة الفاتورة (${base}) إلزامي — سعر الدليل بالعملة الأساسية لا يدخل فاتورةً بعملة اتفاق.`, };
      }
      unitPriceMinor = service ? invoiceCatalogPrice(service, base) : null;
    } else {
      unitPriceMinor = parseAmount(String(priceRaw), base);
    }
    if (unitPriceMinor === null) {
      return { ok: false, message: `اكتب سعرًا صحيحًا لبند «${description}».` };
    }
    if (service && invoiceCatalogPrice(service, base) === null && unitPriceMinor <= 0) {
      if (quote?.source === "converted" && quote.minor === 0) return { ok:false, message:INVOICE_ZERO_CONVERSION_MESSAGE };
      return { ok: false, message: `لا يوجد سعر مقرر لـ «${description}» بهذه العملة؛ اكتب قيمة الاتفاق صراحةً أو اطلب تسعير الخدمة.` };
    }

    const doctorIdRaw = Number(raw.doctorId);
    const doctorId = Number.isInteger(doctorIdRaw) && doctors.has(doctorIdRaw) ? doctorIdRaw : null;
    if (raw.doctorId !== undefined && raw.doctorId !== null && String(raw.doctorId).trim() !== "" && doctorId === null) {
      return { ok: false, message: "الطبيب المختار غير مسجّل." };
    }

    /* (INV-LINK B) السنّ والحالة والجلسات للبند العلاجي — اختيارية؛ والخاطئ يُرفض لا يُسقط صامتًا. */
    const optionalInt = (value: unknown, min: number, max: number): number | null | undefined => {
      if (value === undefined || value === null || String(value).trim() === "") return null;
      const number = Number(value);
      return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
    };
    const toothCode = optionalInt(raw.toothCode, 11, 85);
    const caseId = optionalInt(raw.caseId, 1, 2_147_483_647);
    const planItemId = selectedId(raw.planItemId);
    if (planItemId === undefined) return { ok: false, message: "بند الخطة المختار غير صالح." };
    const sessions = optionalInt(raw.sessions, 1, 60);
    if (toothCode === undefined) return { ok: false, message: "رقم السن غير صحيح بالترقيم الدولي." };
    if (caseId === undefined) return { ok: false, message: "الحالة المختارة غير صالحة." };
    if (sessions === undefined) return { ok: false, message: "عدد جلسات البند بين ١ و٦٠." };
    /* (INV-LINK TOOTH) أسطح الحشوة، أسنان حلقة التاج/الجسر، ونطاق التقويم/اللثة — كما اختيرت من مخطط الأسنان. */
    const siteFields = parseLineSiteFields(raw);
    if (!siteFields) return { ok: false, message: "بيانات موضع البند (الأسنان/الأسطح/النطاق) غير صالحة." };

    let labWork;
    try { labWork = parseLabWorkDraft(raw.labWork); }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : "هوية عمل المختبر غير صالحة." }; }
    if (labWork && !idempotencyKey) return { ok: false, message: "مفتاح الطلب مطلوب لحفظ عمل المختبر مع الفاتورة." };
    items.push({
      serviceId: service ? service.id : null, category: service?.category ?? null, doctorId, description, quantity,
      unitPriceMinor, toothCode, caseId, planItemId, sessions, ...siteFields, ...(labWork ? { labWork } : {}),
    });
    authorityLines.push({
      description, service: service ?? null, requestedMinor: unitPriceMinor, quantity,
      explicit: !(priceRaw === undefined || String(priceRaw).trim() === ""),
      reason: typeof raw.priceReason === "string" ? raw.priceReason : null,
      convertedQuoteAccepted: quote?.source === "converted" && Object.hasOwn(raw, "priceQuote") && unitPriceMinor === quote.minor,
    });
    if (service && quote) pricingSnapshots.push({ line: items.length - 1, serviceId: service.id, quote, requestedMinor: unitPriceMinor,
      agreedPriceSource: unitPriceMinor === quote.minor && (quote.source === "catalog" || Object.hasOwn(raw,"priceQuote")) && quote.source !== "none" ? quote.source : "manual",
      reason: typeof raw.priceReason === "string" ? raw.priceReason.trim().slice(0, 300) || null : null });
  }

  let labRetirements: LabWorkRetirement[] | undefined;
  try {
    const command = normalizeLabWorkGroups(items.map(item => ({ ...item, serviceId: item.serviceId ?? 0, planItemId: item.planItemId ?? null })), source.labRetirements);
    if (Object.hasOwn(source, "labRetirements")) {
      if (!idempotencyKey) return { ok: false, message: "مفتاح الطلب مطلوب لمراجعة أعضاء عمل المختبر." };
      if(command.retirements.length) return {ok:false,message:"إزالة أعضاء وصفة المختبر من الفاتورة غير مدعومة بعد؛ افتح الوصفة للمراجعة دون حذف رابط العمل."};
      labRetirements = command.retirements;
    }
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "مجموعة عمل المختبر غير صالحة." }; }
  const discountMinor = source.discount === undefined || String(source.discount).trim() === ""
    ? 0 : parseAmount(String(source.discount), base);
  if (discountMinor === null) {
    return { ok: false, message: "اكتب خصمًا صحيحًا." };
  }

  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  return { ok: true, patientId, baseCurrency: base, existingPlanId, items, authorityLines, discountMinor, note, idempotencyKey, pricingSnapshots,
    ...(labRetirements ? { labRetirements } : {}),
    ...(quoted.length ? { quotedFingerprint: JSON.stringify(quoted) } : {}), ...(visitId!==null?{visitId}:{}) };
}
