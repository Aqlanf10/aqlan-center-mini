/**
 * (INV-LINK B) الفاتورة العلاجية بدايةٌ مالية مرتبطة بالعلاج — المنطق الخالص.
 *
 * الفاتورة ليست السجل السريري. لكن بندها إن كان خدمةً علاجية واضحة من الدليل يرتبط في العملية نفسها
 * ببند خطة (هوية العمل القانونية) وبحالةٍ تخصصية حين يلزم. هنا: تصنيف البند (علاجي/مالي) من **فئة خدمة
 * الدليل** وحدها — لا من نصٍّ حرّ — وعدد الجلسات من قالب التخصص، ومفاتيح الإعادة.
 * التصميم: docs/INVOICE_FIRST_CLINICAL_LINKAGE.md.
 */
import type { ServiceSpecialty } from "./appointment-services";
import type { SpecialtyTemplate } from "./specialty-templates";

/** تخصص الحالة التي يحتاجها البند، أو `null` لبندٍ علاجيٍّ بلا حالة (الترميم). */
export type LinkageSpecialty = ServiceSpecialty | "restorative";

export type LineLinkage =
  | { kind: "financial" }
  | { kind: "clinical"; specialty: LinkageSpecialty; needsCase: boolean };

/**
 * فئة الدليل ← تخصص العلاج. ما ليس هنا (كشف، أشعة، فئة مجهولة، أو بندٌ بلا خدمة) يبقى ماليًّا فقط.
 * الأطفال لا يُستنتج: لا فئة دليلٍ تحمله.
 */
const CATEGORY_LINKAGE: Record<string, { specialty: LinkageSpecialty; needsCase: boolean }> = {
  ortho: { specialty: "orthodontics", needsCase: true },
  rct: { specialty: "endodontics", needsCase: true },
  post: { specialty: "prosthodontics", needsCase: true },
  crown: { specialty: "prosthodontics", needsCase: true },
  bridge: { specialty: "prosthodontics", needsCase: true },
  implant: { specialty: "implantology", needsCase: true },
  cleaning: { specialty: "periodontics", needsCase: true },
  extraction: { specialty: "surgery", needsCase: true },
  surgery: { specialty: "surgery", needsCase: true },
  veneer: { specialty: "cosmetic", needsCase: true },
  whitening: { specialty: "cosmetic", needsCase: true },
  filling: { specialty: "restorative", needsCase: false },
  sealant: { specialty: "restorative", needsCase: false },
};

export function lineLinkage(input: { serviceId: number | null; category: string | null }): LineLinkage {
  if (input.serviceId === null || !input.category) return { kind: "financial" };
  const found = CATEGORY_LINKAGE[input.category];
  return found ? { kind: "clinical", ...found } : { kind: "financial" };
}

export const LINKAGE_SPECIALTY_LABEL: Record<LinkageSpecialty, string> = {
  general: "عام", orthodontics: "تقويم", endodontics: "علاج جذور", surgery: "جراحة فموية",
  implantology: "زراعة", prosthodontics: "تركيبات", periodontics: "لثة", pediatric: "أطفال",
  radiology: "أشعة وسجلات", consultation: "كشف واستشارة", emergency: "طوارئ", cosmetic: "تجميل",
  other: "أخرى", restorative: "ترميمي",
};

/** عنوان الحالة الأولية: لا تشخيص ولا تفاصيل — فقط أنها تنتظر تقييم الطبيب. */
export function shellCaseTitle(specialty: LinkageSpecialty, toothCode: number | null): string {
  return `${LINKAGE_SPECIALTY_LABEL[specialty]}${toothCode ? ` — سن ${toothCode}` : ""} — تحتاج تقييمًا سريريًّا`;
}

/** جلسات البند: من الطلب إن أُعطيت، وإلا من خطوة قالب التخصص لفئته، وإلا واحدة. */
export function sessionsFor(category: string | null, requested: number | null, templates: readonly SpecialtyTemplate[]): number {
  if (requested !== null && Number.isInteger(requested) && requested >= 1 && requested <= 60) return requested;
  if (category) {
    for (const template of templates) {
      const step = template.steps.find((one) => one.category === category);
      if (step && step.sessions.length > 0) return step.sessions.length;
    }
  }
  return 1;
}

/** تخصصاتٌ تُعالج سنًّا بعينه: حالتها حلقةٌ لموضعها — بند سنٍّ آخر لا يُلحق بها. التقويم واللثة والتجميل للفم كله. */
const SITE_SPECIFIC: ReadonlySet<LinkageSpecialty> = new Set(["endodontics", "prosthodontics", "implantology", "surgery"]);

/**
 * هل تصلح حالةٌ مفتوحة لبندٍ على سنٍّ ما؟ للتخصص الموضعي: موضع الحالة فارغ، أو يذكر السن نفسه رقمًا مستقلًّا.
 * بند بلا سن، أو تخصصٌ للفم كله ⇒ تصلح أي حالة مفتوحة للتخصص.
 */
export function caseSiteCompatible(specialty: LinkageSpecialty, caseSite: string | null, toothCode: number | null): boolean {
  if (!SITE_SPECIFIC.has(specialty) || toothCode === null) return true;
  const site = (caseSite ?? "").trim();
  if (site === "") return true;
  return site.split(/[^0-9]+/).filter(Boolean).some((token) => Number(token) === toothCode);
}

/** مفتاح تجميع البنود على حالةٍ واحدة داخل الفاتورة: التخصص، والسن للتخصص الموضعي. */
export function caseGroupKey(specialty: LinkageSpecialty, toothCode: number | null): string {
  return SITE_SPECIFIC.has(specialty) && toothCode !== null ? `${specialty}:${toothCode}` : specialty;
}

export const INVOICE_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** بصمة الطلب لمفتاح الإعادة: كل ما يُحفظ من الطلب (المريض، العملة، الخصم، الملاحظة، البنود بجلساتها) — بترتيبٍ ثابت. */
export function invoiceRequestFingerprint(input: {
  patientId: number; currency: string; discountMinor: number; note?: string | null;
  items: { serviceId: number | null; description: string; quantity: number; unitPriceMinor: number;
    doctorId: number | null; toothCode?: number | null; caseId?: number | null; sessions?: number | null }[];
}): string {
  return JSON.stringify([
    input.patientId, input.currency, input.discountMinor, input.note ?? null,
    input.items.map((item) => [item.serviceId, item.description, item.quantity, item.unitPriceMinor,
      item.doctorId, item.toothCode ?? null, item.caseId ?? null, item.sessions ?? null]),
  ]);
}

export type InvoiceLinkageRefusal =
  | "idempotency_conflict" | "ambiguous_case" | "bad_case" | "amount_mismatch" | "bad_tooth" | "already_billed"
  | "case_mismatch" | "shape_mismatch" | "ambiguous_item" | "legacy_covered";

export const INVOICE_LINKAGE_MESSAGE: Record<InvoiceLinkageRefusal, string> = {
  idempotency_conflict: "هذا الطلب أُرسل سابقًا ببنودٍ مختلفة — أعد فتح نموذج الفاتورة.",
  ambiguous_case: "للمريض أكثر من حالة مفتوحة لهذا التخصص — اختر الحالة التي يرتبط بها البند.",
  bad_case: "الحالة المختارة ليست حالة مفتوحة لهذا المريض وبتخصص البند.",
  amount_mismatch: "يوجد بند خطة مفتوح لنفس الخدمة والسن بمبلغٍ مختلف — فوتِر البند بمبلغه في الخطة أو صحّح الخطة أولًا.",
  bad_tooth: "رقم السن غير صحيح بالترقيم الدولي.",
  case_mismatch: "بند الخطة المطابق لهذا العلاج مرتبط بحالةٍ أخرى — اختر حالته أو اترك الحالة للربط التلقائي.",
  shape_mismatch: "يوجد بند خطة مفتوح لنفس الخدمة والسن بكميةٍ أو عدد جلساتٍ أو أسطحٍ مختلفة — طابِق الفاتورة مع الخطة أو اطلب من الطبيب تعديلها أولًا.",
  ambiguous_item: "يوجد أكثر من بند خطة مفتوح مطابق لهذا العلاج — راجع الخطة قبل إصدار الفاتورة.",
  legacy_covered: "هذا العلاج مسجّل «علاجًا بدأ قبل النظام» باتفاقٍ تاريخي قائم — لا تُصدر له فاتورة: المتبقي في الرصيد السابق والجلسات مشمولة.",
  already_billed: "هذا العلاج مفوتر مسبقًا لهذا المريض بفاتورةٍ قائمة ولم يبدأ بعد — لا تُصدر فاتورةً ثانية للعمل نفسه (ألغِ الأولى أو صحّحها إن كان خطأ).",
};
