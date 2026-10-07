/**
 * (INV-LINK B) الفاتورة العلاجية بدايةٌ مالية مرتبطة بالعلاج — المنطق الخالص.
 *
 * الفاتورة ليست السجل السريري. لكن بندها إن كان خدمةً علاجية واضحة من الدليل يرتبط في العملية نفسها
 * ببند خطة (هوية العمل القانونية) وبحالةٍ تخصصية حين يلزم. هنا: تصنيف البند (علاجي/مالي) من **فئة خدمة
 * الدليل** وحدها — لا من نصٍّ حرّ — وعدد الجلسات من قالب التخصص، ومفاتيح الإعادة.
 * التصميم: docs/INVOICE_FIRST_CLINICAL_LINKAGE.md.
 */
import type { ServiceSpecialty } from "./appointment-services";
import { MAX_SELECTED_TEETH, isValidTooth, normalizeSurfaces } from "./dental";
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

/**
 * (INV-LINK TOOTH) كيف تُحدَّد أسنان/موضع البند — من فئة خدمة الدليل وحدها (مصدرٌ واحد للخادم والواجهة):
 * - `none`: كشف/أشعة/تبييض/مالي — لا يُسأل عن سن.
 * - `per_tooth_episode`: عصب، وتد، زراعة، خلع، جراحة — سنٌّ واحد لكل حلقة؛ عدة أسنان ⇒ سطرٌ وحالةٌ لكل سن.
 * - `multi_tooth_episode`: تاج، قشرة، جسر — سنٌّ أو أكثر؛ بندٌ لكل سن/وحدة وحلقةٌ واحدة للاختيار كله
 *   (لا تُستنتج دعامات الجسر — كل سن وحدة كما في قالب التركيبات).
 * - `tooth_surfaces`: حشوة، سدّ شقوق — سنٌّ واحد لكل سطر مع أسطحه (M O D B L) إن وُجدت.
 * - `region`: تنظيف/لثة — كامل الفم أو فك أو سن، اختياري.
 * - `arch`: تقويم — علوي/سفلي/كلاهما، لا سنٌّ منفرد.
 */
export type ToothScopeMode =
  | "none" | "per_tooth_episode" | "multi_tooth_episode" | "tooth_surfaces" | "region" | "arch";

const CATEGORY_TOOTH_SCOPE: Record<string, ToothScopeMode> = {
  rct: "per_tooth_episode", post: "per_tooth_episode", implant: "per_tooth_episode",
  extraction: "per_tooth_episode", surgery: "per_tooth_episode",
  crown: "multi_tooth_episode", veneer: "multi_tooth_episode", bridge: "multi_tooth_episode",
  filling: "tooth_surfaces", sealant: "tooth_surfaces",
  cleaning: "region",
  ortho: "arch",
};

export function toothScope(category: string | null): ToothScopeMode {
  return category && Object.hasOwn(CATEGORY_TOOTH_SCOPE, category) ? CATEGORY_TOOTH_SCOPE[category] : "none";
}

/** البند لا يُحفظ مرتبطًا سريريًّا بلا سن في هذه الأنماط (fail closed). */
export function toothRequired(mode: ToothScopeMode): boolean {
  return mode === "per_tooth_episode" || mode === "multi_tooth_episode" || mode === "tooth_surfaces";
}

/** نطاقٌ بلا أسنانٍ محددة: فكّ أو الفكّان (التقويم) أو كامل الفم (اللثة). */
export type SiteScope = "upper" | "lower" | "both" | "full_mouth";

export const SITE_SCOPE_LABEL: Record<SiteScope, string> = {
  upper: "الفك العلوي", lower: "الفك السفلي", both: "الفكّان", full_mouth: "كامل الفم",
};

/** النطاقات المسموحة لكل نمط (فارغة = لا نطاق). */
export function allowedScopes(mode: ToothScopeMode): readonly SiteScope[] {
  if (mode === "arch") return ["upper", "lower", "both"];
  if (mode === "region") return ["full_mouth", "upper", "lower"];
  return [];
}

/** موضع البند كما يُحفظ: سنٌّ، أو أسنان حلقةٍ واحدة، أو أسطح، أو نطاق — بعد التحقق والتطبيع. */
export interface LineSite {
  mode: ToothScopeMode;
  toothCode: number | null;
  /** أسطح الحشوة مطبَّعة بترتيب الدليل (MDOBL) أو `null`. */
  surfaces: string | null;
  /** أسنان الحلقة (تاج/قشرة/جسر) مرتّبة تصاعديًّا — `null` لغير الحلقات متعددة الأسنان. */
  episodeTeeth: number[] | null;
  scope: SiteScope | null;
}

const SURFACE_INPUT = /^[MDOBLmdobl\s,،/-]*$/;
/**
 * (INV-LINK TOOTH) تحقق موضع البند العلاجي — قاعدةٌ واحدة يطبّقها الحفظ والمعاينة (فلا تختلف رسالة المعاينة عن رفض الحفظ).
 * fail closed: خدمةٌ تخص سنًّا بلا سن ⇒ `tooth_required`؛ حلقة عصب/زراعة/خلع بأكثر من سن ⇒ `episode_split_required`.
 * النمط `none` يتجاهل كل حقول الموضع (البند المالي لا يُحفظ له موضع).
 */
export function validateLineSite(input: {
  category: string | null; toothCode: number | null; surfaces?: string | null;
  episodeTeeth?: readonly number[] | null; scope?: string | null;
}): { ok: true; site: LineSite } | { ok: false; reason: InvoiceLinkageRefusal } {
  const mode = toothScope(input.category);
  if (mode === "none") return { ok: true, site: { mode, toothCode: null, surfaces: null, episodeTeeth: null, scope: null } };
  const tooth = input.toothCode;
  if (tooth !== null && !isValidTooth(tooth)) return { ok: false, reason: "bad_tooth" };
  const scopeRaw = input.scope ?? null;
  const scope = scopeRaw === null || scopeRaw === "" ? null : scopeRaw;
  if (scope !== null && !(allowedScopes(mode) as readonly string[]).includes(scope)) return { ok: false, reason: "bad_scope" };
  if (toothRequired(mode) && tooth === null) return { ok: false, reason: "tooth_required" };
  const teethIn = input.episodeTeeth ?? null;
  if (teethIn !== null && (teethIn.length > MAX_SELECTED_TEETH || teethIn.some((code) => !isValidTooth(code)))) {
    return { ok: false, reason: "bad_tooth" };
  }
  const teeth = teethIn === null ? null : [...new Set(teethIn)].sort((a, b) => a - b);
  switch (mode) {
    case "per_tooth_episode":
      if (teeth !== null && (teeth.length > 1 || (teeth.length === 1 && teeth[0] !== tooth))) {
        return { ok: false, reason: "episode_split_required" };
      }
      return { ok: true, site: { mode, toothCode: tooth, surfaces: null, episodeTeeth: null, scope: null } };
    case "multi_tooth_episode": {
      const episode = teeth === null || teeth.length === 0 ? [tooth!] : teeth;
      if (!episode.includes(tooth!)) return { ok: false, reason: "bad_tooth" };
      return { ok: true, site: { mode, toothCode: tooth, surfaces: null, episodeTeeth: episode, scope: null } };
    }
    case "tooth_surfaces": {
      const raw = (input.surfaces ?? "").trim();
      if (raw !== "" && !SURFACE_INPUT.test(raw)) return { ok: false, reason: "bad_surfaces" };
      return { ok: true, site: { mode, toothCode: tooth, surfaces: normalizeSurfaces(raw), episodeTeeth: null, scope: null } };
    }
    case "arch":
      if (tooth !== null) return { ok: false, reason: "bad_scope" };
      return { ok: true, site: { mode, toothCode: null, surfaces: null, episodeTeeth: null, scope: scope as SiteScope | null } };
    case "region":
      if (tooth !== null && scope !== null) return { ok: false, reason: "bad_scope" };
      return { ok: true, site: { mode, toothCode: tooth, surfaces: null, episodeTeeth: null, scope: scope as SiteScope | null } };
  }
}

/** نصّ موضع الحالة الأولية: أسنان الحلقة «14، 15، 16»، أو السن، أو اسم النطاق. */
export function siteText(site: LineSite): string | null {
  if (site.episodeTeeth && site.episodeTeeth.length > 0) return site.episodeTeeth.join("، ");
  if (site.toothCode !== null) return String(site.toothCode);
  if (site.scope !== null) return SITE_SCOPE_LABEL[site.scope];
  return null;
}

/** ملاحظة بند الخطة للنطاق بلا أسنان (التقويم/اللثة) — يقرؤها الطبيب في الخطة. */
export function scopeNote(site: LineSite): string | null {
  return site.scope !== null ? `النطاق: ${SITE_SCOPE_LABEL[site.scope]}` : null;
}

/** مفتاح تجميع الحالة لموضعٍ مُتحقَّق: حلقة الأسنان المتعددة حالةٌ واحدة لأسنانها كلها. */
export function siteGroupKey(specialty: LinkageSpecialty, site: LineSite): string {
  if (site.episodeTeeth && site.episodeTeeth.length > 1) return `${specialty}:ep:${site.episodeTeeth.join(",")}`;
  return caseGroupKey(specialty, site.toothCode);
}

/** هل تصلح حالةٌ مفتوحة لهذا الموضع؟ حلقة الأسنان المتعددة تحتاج حالةً موضعها فارغ أو يذكر أسنانها كلها. */
export function caseSiteFits(specialty: LinkageSpecialty, caseSite: string | null, site: LineSite): boolean {
  if (site.episodeTeeth && site.episodeTeeth.length > 1) {
    return site.episodeTeeth.every((tooth) => caseSiteCompatible(specialty, caseSite, tooth));
  }
  return caseSiteCompatible(specialty, caseSite, site.toothCode);
}

/** عنوان الحالة الأولية بموضعها. */
export function shellCaseTitleFor(specialty: LinkageSpecialty, site: LineSite): string {
  const where = site.episodeTeeth && site.episodeTeeth.length > 1 ? ` — أسنان ${site.episodeTeeth.join("، ")}`
    : site.toothCode !== null ? ` — سن ${site.toothCode}`
    : site.scope !== null ? ` — ${SITE_SCOPE_LABEL[site.scope]}` : "";
  return `${LINKAGE_SPECIALTY_LABEL[specialty]}${where} — تحتاج تقييمًا سريريًّا`;
}

/**
 * حقول الموضع من جسم الطلب (فاتورة أو معاينة) — شكلًا فقط؛ المعنى يحكمه `validateLineSite`.
 * `null` لما لم يُرسل؛ `undefined` لشكلٍ خاطئ (يُرفض 400 لا يُسقط صامتًا).
 */
export function parseLineSiteFields(raw: Record<string, unknown>):
  { surfaces: string | null; episodeTeeth: number[] | null; scope: string | null } | undefined {
  const text = (value: unknown, max: number): string | null | undefined => {
    if (value === undefined || value === null || String(value).trim() === "") return null;
    return typeof value === "string" && value.length <= max ? value.trim() : undefined;
  };
  const surfaces = text(raw.surfaces, 20);
  const scope = text(raw.scope, 20);
  let episodeTeeth: number[] | null | undefined = null;
  if (raw.episodeTeeth !== undefined && raw.episodeTeeth !== null) {
    episodeTeeth = Array.isArray(raw.episodeTeeth) && raw.episodeTeeth.length <= MAX_SELECTED_TEETH
      && raw.episodeTeeth.every((tooth) => Number.isInteger(tooth))
      ? (raw.episodeTeeth as number[]) : undefined;
  }
  if (surfaces === undefined || scope === undefined || episodeTeeth === undefined) return undefined;
  return { surfaces, episodeTeeth: episodeTeeth && episodeTeeth.length > 0 ? episodeTeeth : null, scope };
}

/** حالة HTTP لرفض الربط: خطأ إدخالٍ في البند ⇒ 400، وتعارضٌ مع حالة المريض القائمة ⇒ 409. */
export function linkageRefusalStatus(reason: InvoiceLinkageRefusal): 400 | 409 {
  return reason === "bad_tooth" || reason === "bad_case" || reason === "tooth_required"
    || reason === "episode_split_required" || reason === "bad_surfaces" || reason === "bad_scope" ? 400 : 409;
}

export const INVOICE_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** بصمة الطلب لمفتاح الإعادة: كل ما يُحفظ من الطلب (المريض، العملة، الخصم، الملاحظة، البنود بجلساتها) — بترتيبٍ ثابت. */
export function invoiceRequestFingerprint(input: {
  patientId: number; currency: string; discountMinor: number; note?: string | null;
  items: { serviceId: number | null; description: string; quantity: number; unitPriceMinor: number;
    doctorId: number | null; toothCode?: number | null; caseId?: number | null; sessions?: number | null;
    surfaces?: string | null; episodeTeeth?: readonly number[] | null; scope?: string | null }[];
}): string {
  return JSON.stringify([
    input.patientId, input.currency, input.discountMinor, input.note ?? null,
    input.items.map((item) => [item.serviceId, item.description, item.quantity, item.unitPriceMinor,
      item.doctorId, item.toothCode ?? null, item.caseId ?? null, item.sessions ?? null,
      item.surfaces ?? null, item.episodeTeeth ? [...item.episodeTeeth] : null, item.scope ?? null]),
  ]);
}

export type InvoiceLinkageRefusal =
  | "idempotency_conflict" | "ambiguous_case" | "bad_case" | "amount_mismatch" | "bad_tooth" | "already_billed"
  | "case_mismatch" | "shape_mismatch" | "ambiguous_item" | "legacy_covered"
  | "tooth_required" | "episode_split_required" | "bad_surfaces" | "bad_scope";

export const INVOICE_LINKAGE_MESSAGE: Record<InvoiceLinkageRefusal, string> = {
  idempotency_conflict: "هذا الطلب أُرسل سابقًا ببنودٍ مختلفة — أعد فتح نموذج الفاتورة.",
  ambiguous_case: "للمريض أكثر من حالة مفتوحة لهذا التخصص — اختر الحالة التي يرتبط بها البند.",
  bad_case: "الحالة المختارة ليست حالة مفتوحة لهذا المريض وبتخصص البند.",
  amount_mismatch: "يوجد بند خطة مفتوح لنفس الخدمة والسن بمبلغٍ مختلف — فوتِر البند بمبلغه في الخطة أو صحّح الخطة أولًا.",
  bad_tooth: "رقم السن غير صحيح بالترقيم الدولي.",
  tooth_required: "هذه الخدمة تخص سنًّا بعينه — حدّد السن من مخطط الأسنان قبل الحفظ.",
  episode_split_required: "علاج العصب/الزراعة/الخلع حالةٌ مستقلة لكل سن — قسّم البند سطرًا لكل سن.",
  bad_surfaces: "أسطح السن غير صحيحة — المسموح M و D و O و B و L.",
  bad_scope: "نطاق العلاج غير مناسب لهذه الخدمة (التقويم: علوي/سفلي/الفكّان، اللثة: كامل الفم/فك أو سن).",
  case_mismatch: "بند الخطة المطابق لهذا العلاج مرتبط بحالةٍ أخرى — اختر حالته أو اترك الحالة للربط التلقائي.",
  shape_mismatch: "يوجد بند خطة مفتوح لنفس الخدمة والسن بكميةٍ أو عدد جلساتٍ أو أسطحٍ مختلفة — طابِق الفاتورة مع الخطة أو اطلب من الطبيب تعديلها أولًا.",
  ambiguous_item: "يوجد أكثر من بند خطة مفتوح مطابق لهذا العلاج — راجع الخطة قبل إصدار الفاتورة.",
  legacy_covered: "هذا العلاج مسجّل «علاجًا بدأ قبل النظام» باتفاقٍ تاريخي قائم — لا تُصدر له فاتورة: المتبقي في الرصيد السابق والجلسات مشمولة.",
  already_billed: "هذا العلاج مفوتر مسبقًا لهذا المريض بفاتورةٍ قائمة ولم يبدأ بعد — لا تُصدر فاتورةً ثانية للعمل نفسه (ألغِ الأولى أو صحّحها إن كان خطأ).",
};
