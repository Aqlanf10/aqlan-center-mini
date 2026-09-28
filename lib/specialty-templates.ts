/**
 * (SPEC-T1) قوالب الخطط حسب التخصص — منطقٌ خالص يُختبر بلا قاعدة. التصميم في
 * docs/SPECIALTY_TEMPLATES.md.
 *
 * القالب خطواتٌ مرتّبة؛ والخطوة فئة خدمةٍ من الدليل (لا سعرٌ مكتوب)، لكل سنٍّ أو للفم كله،
 * بقاعدة فوترتها وجلساتها (عنوانٌ ومدةٌ وفاصلٌ بالأيام). والتحويل إلى خطة يصنع مسوّدات بنود
 * `createPlanV2` نفسها — بأسعار الدليل بعملة الخطة، محسوبةً على الخادم.
 */
import { CURRENCY_LABEL, type Currency } from "./money";
import { catalogPriceIn, type ForeignRates, type PricedService } from "./service-pricing";
import { MAX_SESSION_COUNT, type BillingRule } from "./workflow";

export interface TemplateSession {
  title: string;
  minutes: number;
  /** الفاصل بالأيام عن الجلسة السابقة (للمواعيد القادمة — T4). */
  afterDays: number;
}

export interface TemplateStep {
  key: string;
  title: string;
  /** فئة الخدمة في الدليل (rct، crown، ortho…). */
  category: string;
  /** اسم الخدمة المفضّل — إن لم يوجد في دليل المركز فأول خدمةٍ فعّالة من الفئة. */
  preferredService: string | null;
  perTooth: boolean;
  optional: boolean;
  billingRule: BillingRule;
  /** خطوةٌ تصنع عملًا للمختبر (تاج، جسر…) — يُنشأ طلبه في وقته (T3). */
  labWork: boolean;
  sessions: TemplateSession[];
}

export interface SpecialtyTemplate {
  id: string;
  /** يُحفظ في الخطة (treatment_plans.specialty). */
  specialty: string;
  name: string;
  description: string;
  steps: TemplateStep[];
}

const session = (title: string, minutes: number, afterDays = 0): TemplateSession => ({ title, minutes, afterDays });

/** القوالب الجاهزة — نقطة بدايةٍ يعدّلها المالك من الإعدادات (T2). */
export const DEFAULT_SPECIALTY_TEMPLATES: SpecialtyTemplate[] = [
  {
    id: "endo", specialty: "علاج عصب", name: "علاج عصب + تاج",
    description: "علاج الجذور على ثلاث جلسات، ثم وتدٌ وتاجٌ إن لزم.",
    steps: [
      {
        key: "rct", title: "علاج الجذور", category: "rct", preferredService: null,
        perTooth: true, optional: false, billingRule: "per_session", labWork: false,
        sessions: [
          session("فتح السن وتنظيف القنوات", 45),
          session("تشكيل وتعقيم القنوات", 45, 7),
          session("حشو القنوات النهائي", 45, 7),
        ],
      },
      {
        key: "post", title: "وتد وبناء", category: "post", preferredService: "وتد ألياف زجاجية",
        perTooth: true, optional: true, billingRule: "on_completion", labWork: false,
        sessions: [session("وضع الوتد وبناء النواة", 30, 0)],
      },
      {
        key: "crown", title: "تاج", category: "crown", preferredService: "تاج زركونيا",
        perTooth: true, optional: true, billingRule: "on_start", labWork: true,
        sessions: [session("تحضير السن وأخذ الطبعة", 45, 3), session("تركيب التاج", 30, 10)],
      },
    ],
  },
  {
    id: "filling", specialty: "حشوات", name: "حشوات",
    description: "حشوةٌ لكل سنٍّ في جلسة.",
    steps: [{
      key: "filling", title: "حشوة", category: "filling", preferredService: "حشوة ضوئية",
      perTooth: true, optional: false, billingRule: "on_completion", labWork: false,
      sessions: [session("حشو السن", 30)],
    }],
  },
  {
    id: "crowns", specialty: "تركيبات", name: "تيجان",
    description: "تاجٌ لكل سن: تحضير وطبعة، ثم تجربة، ثم تركيب.",
    steps: [{
      key: "crown", title: "تاج", category: "crown", preferredService: "تاج زركونيا",
      perTooth: true, optional: false, billingRule: "on_start", labWork: true,
      sessions: [session("تحضير السن وأخذ الطبعة", 45), session("تجربة التاج", 20, 7), session("تركيب التاج", 30, 7)],
    }],
  },
  {
    id: "bridge", specialty: "تركيبات", name: "جسر ثابت",
    description: "وحدة جسرٍ لكل سن (الدعامات والسن المفقود).",
    steps: [{
      key: "bridge", title: "وحدة جسر", category: "bridge", preferredService: "جسر زركونيا (لكل سن)",
      perTooth: true, optional: false, billingRule: "on_start", labWork: true,
      sessions: [session("تحضير الدعامات وأخذ الطبعة", 60), session("تجربة الجسر", 30, 7), session("تركيب الجسر", 45, 7)],
    }],
  },
  {
    id: "ortho", specialty: "تقويم", name: "تقويم ثابت",
    description: "تركيب الحاصرات، ثم مراجعاتٌ كل ٢٨ يومًا، ثم فكّ التقويم والتثبيت — والرسوم موزّعة على الجلسات.",
    steps: [
      {
        key: "records", title: "فحص وسجلات التقويم", category: "consultation", preferredService: "كشف واستشارة",
        perTooth: false, optional: true, billingRule: "on_completion", labWork: false,
        sessions: [session("فحص وتشخيص وصور وأشعة", 45)],
      },
      {
        key: "ortho", title: "التقويم الثابت", category: "ortho", preferredService: "تركيب تقويم ثابت (فكّان)",
        perTooth: false, optional: false, billingRule: "per_session", labWork: false,
        sessions: [
          session("تركيب الحاصرات والسلك الأول", 90, 7),
          ...Array.from({ length: 10 }, (_, index) => session(`مراجعة وشدّ ${index + 1}`, 30, 28)),
          session("فكّ التقويم وتركيب المثبّت", 60, 28),
        ],
      },
    ],
  },
  {
    id: "implant", specialty: "زراعة", name: "زراعة سن",
    description: "الغرسة ثم متابعة الالتئام ثم تاجٌ على الغرسة.",
    steps: [
      {
        key: "implant", title: "الغرسة", category: "implant", preferredService: null,
        perTooth: true, optional: false, billingRule: "on_start", labWork: false,
        sessions: [session("جراحة وضع الغرسة", 60), session("متابعة وفكّ الغرز", 20, 10), session("كشف الالتحام", 20, 80)],
      },
      {
        key: "crown", title: "تاج على الغرسة", category: "crown", preferredService: "تاج زركونيا",
        perTooth: true, optional: true, billingRule: "on_start", labWork: true,
        sessions: [session("طبعة التاج على الغرسة", 30, 7), session("تركيب التاج", 30, 14)],
      },
    ],
  },
  {
    id: "cleaning", specialty: "علاج عام", name: "تنظيف ولثة",
    description: "تنظيف الجير والتلميع.",
    steps: [{
      key: "cleaning", title: "تنظيف", category: "cleaning", preferredService: "تنظيف جير كامل",
      perTooth: false, optional: false, billingRule: "on_completion", labWork: false,
      sessions: [session("تنظيف الجير والتلميع", 45)],
    }],
  },
  {
    id: "surgery", specialty: "جراحة", name: "خلع جراحي",
    description: "الخلع الجراحي ثم متابعة وفكّ الغرز.",
    steps: [
      {
        key: "surgery", title: "خلع جراحي", category: "surgery", preferredService: null,
        perTooth: true, optional: false, billingRule: "on_completion", labWork: false,
        sessions: [session("الخلع الجراحي", 45)],
      },
      {
        key: "followup", title: "متابعة", category: "consultation", preferredService: "زيارة متابعة",
        perTooth: false, optional: true, billingRule: "on_completion", labWork: false,
        sessions: [session("متابعة وفكّ الغرز", 15, 7)],
      },
    ],
  },
];

/* ─────────────────────────── التحقق ─────────────────────────── */

/** مشكلات القالب بالعربية — فارغةٌ إن كان سليمًا. */
export function templateProblems(template: SpecialtyTemplate): string[] {
  const problems: string[] = [];
  if (!template.id.trim() || !/^[a-z0-9_-]{1,40}$/.test(template.id)) problems.push("معرّف القالب غير صالح.");
  if (!template.name.trim()) problems.push("اسم القالب فارغ.");
  if (template.steps.length === 0) problems.push(`القالب «${template.name}» بلا خطوات.`);
  if (template.steps.every((step) => step.optional)) problems.push(`القالب «${template.name}» يحتاج خطوةً إلزامية واحدة على الأقل.`);
  const keys = new Set<string>();
  for (const step of template.steps) {
    const label = `«${template.name}» ← «${step.title}»`;
    if (keys.has(step.key)) problems.push(`${label}: مفتاح الخطوة مكرر.`);
    keys.add(step.key);
    if (!step.category.trim()) problems.push(`${label}: فئة الخدمة فارغة.`);
    if (step.sessions.length === 0) problems.push(`${label}: بلا جلسات.`);
    if (step.sessions.length > MAX_SESSION_COUNT) problems.push(`${label}: أكثر من ${MAX_SESSION_COUNT} جلسة.`);
    for (const item of step.sessions) {
      if (!item.title.trim()) problems.push(`${label}: جلسةٌ بلا عنوان.`);
      if (!Number.isInteger(item.minutes) || item.minutes < 5 || item.minutes > 480) problems.push(`${label}: مدة الجلسة بين ٥ و٤٨٠ دقيقة.`);
      if (!Number.isInteger(item.afterDays) || item.afterDays < 0 || item.afterDays > 365) problems.push(`${label}: الفاصل بين ٠ و٣٦٥ يومًا.`);
    }
  }
  return problems;
}

/* ─────────────────────────── التخزين في الإعدادات (T2) ─────────────────────────── */

export const MAX_TEMPLATES = 40;
const BILLING_RULE_VALUES: readonly BillingRule[] = ["on_start", "on_completion", "per_session"];

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}
function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** قالبٌ من JSON المخزَّن — بنيةٌ صارمة: ما لا يطابق النوع يُردّ لا يُخمَّن. */
function coerceTemplate(raw: unknown, index: number): { ok: true; template: SpecialtyTemplate } | { ok: false; message: string } {
  const where = `القالب رقم ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: `${where}: بنية غير صالحة.` };
  const source = raw as Record<string, unknown>;
  const id = text(source.id, 40);
  const name = text(source.name, 80);
  const specialty = text(source.specialty, 80);
  if (!id || !name || !specialty) return { ok: false, message: `${where}: المعرّف والاسم والتخصص مطلوبة.` };
  if (!Array.isArray(source.steps)) return { ok: false, message: `«${name}»: الخطوات قائمة.` };
  const steps: TemplateStep[] = [];
  for (const [stepIndex, rawStep] of source.steps.slice(0, 20).entries()) {
    const step = (rawStep ?? {}) as Record<string, unknown>;
    const title = text(step.title, 80);
    const key = text(step.key, 40) ?? `s${stepIndex + 1}`;
    const category = text(step.category, 40);
    if (!title || !category) return { ok: false, message: `«${name}»: الخطوة ${stepIndex + 1} تحتاج عنوانًا وفئة خدمة.` };
    if (!BILLING_RULE_VALUES.includes(step.billingRule as BillingRule)) {
      return { ok: false, message: `«${name}» ← «${title}»: قاعدة فوترة غير معروفة.` };
    }
    if (!Array.isArray(step.sessions)) return { ok: false, message: `«${name}» ← «${title}»: الجلسات قائمة.` };
    const sessions: TemplateSession[] = [];
    for (const rawSession of step.sessions.slice(0, MAX_SESSION_COUNT + 1)) {
      const item = (rawSession ?? {}) as Record<string, unknown>;
      const minutes = whole(item.minutes);
      const afterDays = whole(item.afterDays);
      sessions.push({ title: text(item.title, 80) ?? "", minutes: minutes ?? -1, afterDays: afterDays ?? -1 });
    }
    steps.push({
      key, title, category,
      preferredService: text(step.preferredService, 120),
      perTooth: step.perTooth === true,
      optional: step.optional === true,
      billingRule: step.billingRule as BillingRule,
      labWork: step.labWork === true,
      sessions,
    });
  }
  return { ok: true, template: { id, name, specialty, description: text(source.description, 300) ?? "", steps } };
}

/** قوالب الإعدادات: فارغ = الجاهزة؛ وإلا تُفحص كاملة وتُردّ بأول مشكلاتها بالعربية. */
export function parseSpecialtyTemplates(raw: string): { ok: true; templates: SpecialtyTemplate[] } | { ok: false; message: string } {
  const value = raw.trim();
  if (!value) return { ok: true, templates: DEFAULT_SPECIALTY_TEMPLATES };
  let data: unknown;
  try { data = JSON.parse(value); } catch { return { ok: false, message: "صيغة القوالب غير صالحة." }; }
  if (!Array.isArray(data)) return { ok: false, message: "القوالب قائمة." };
  if (data.length === 0) return { ok: false, message: "أبقِ قالبًا واحدًا على الأقل — أو استعد القوالب الجاهزة." };
  if (data.length > MAX_TEMPLATES) return { ok: false, message: `أكثر من ${MAX_TEMPLATES} قالبًا.` };
  const templates: SpecialtyTemplate[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of data.entries()) {
    const coerced = coerceTemplate(raw, index);
    if (!coerced.ok) return coerced;
    if (ids.has(coerced.template.id)) return { ok: false, message: `معرّف القالب «${coerced.template.id}» مكرر.` };
    ids.add(coerced.template.id);
    const problems = templateProblems(coerced.template);
    if (problems.length) return { ok: false, message: problems.slice(0, 3).join(" · ") };
    templates.push(coerced.template);
  }
  return { ok: true, templates };
}

/** القوالب الفعّالة: المحفوظة في الإعدادات إن صحّت، وإلا الجاهزة — لا يتعطّل الطبيب بقيمةٍ تالفة. */
export function effectiveTemplates(raw: string | null | undefined): { templates: SpecialtyTemplate[]; customized: boolean } {
  const parsed = parseSpecialtyTemplates(raw ?? "");
  if (!parsed.ok) return { templates: DEFAULT_SPECIALTY_TEMPLATES, customized: false };
  return { templates: parsed.templates, customized: Boolean(raw?.trim()) };
}

/* ─────────────────────────── التحويل إلى خطة ─────────────────────────── */

export interface CatalogServiceForTemplate extends PricedService {
  id: number;
  name: string;
  category: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface TemplateSelection {
  teeth: number[];
  steps: { key: string; include: boolean; serviceId: number | null }[];
}

export interface TemplatePlanDraft {
  serviceId: number;
  serviceName: string;
  category: string;
  toothCode: number | null;
  unitPriceMinor: number;
  billingRule: BillingRule;
  labWork: boolean;
  /** جلسات البند كما في القالب — والمفتاح يجمع الجلسة نفسها لعدة أسنان في زيارةٍ مخطَّطة واحدة. */
  sessions: { title: string; minutes: number; afterDays: number; visitKey: string; visitTitle: string }[];
}

export type TemplateBuildResult =
  | { ok: true; drafts: TemplatePlanDraft[] }
  | { ok: false; message: string };

/** الخدمات المرشّحة لخطوة — فعّالةٌ من فئتها بترتيب الدليل (للاختيار في الشاشة). */
export function stepServiceOptions(step: TemplateStep, services: readonly CatalogServiceForTemplate[]): CatalogServiceForTemplate[] {
  return services
    .filter((service) => service.isActive && service.category === step.category)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/** الخدمة الافتراضية لخطوة: المفضّلة بالاسم إن وُجدت، وإلا الأولى من فئتها. */
export function defaultStepService(step: TemplateStep, services: readonly CatalogServiceForTemplate[]): CatalogServiceForTemplate | null {
  const options = stepServiceOptions(step, services);
  return options.find((service) => service.name === step.preferredService) ?? options[0] ?? null;
}

function toothList(teeth: readonly number[]): string {
  return teeth.map(String).join("، ");
}

export function buildTemplateDrafts(
  template: SpecialtyTemplate,
  selection: TemplateSelection,
  services: readonly CatalogServiceForTemplate[],
  currency: Currency,
  rates: ForeignRates,
): TemplateBuildResult {
  const teeth = [...new Set(selection.teeth)];
  const chosen = new Map(selection.steps.map((step) => [step.key, step]));
  const drafts: TemplatePlanDraft[] = [];

  for (const step of template.steps) {
    const choice = chosen.get(step.key);
    const include = step.optional ? Boolean(choice?.include) : true;
    if (!include) continue;

    const options = stepServiceOptions(step, services);
    const service = choice?.serviceId
      ? options.find((option) => option.id === choice.serviceId) ?? null
      : defaultStepService(step, services);
    if (!service) {
      return {
        ok: false,
        message: choice?.serviceId
          ? `الخدمة المختارة لخطوة «${step.title}» ليست من فئتها أو غير فعّالة.`
          : `لا خدمة فعّالة في الدليل لخطوة «${step.title}» — أضفها إلى الدليل أولًا.`,
      };
    }
    const price = catalogPriceIn(service, currency, rates);
    if (price.minor === null || price.minor <= 0) {
      return { ok: false, message: `لا سعر لخدمة «${service.name}» بعملة الخطة (${CURRENCY_LABEL[currency]}) — اضبط سعرها أو سعر الصرف أولًا.` };
    }
    if (step.perTooth && teeth.length === 0) {
      return { ok: false, message: `اختر السن أو الأسنان لخطوة «${step.title}».` };
    }

    const toothCodes: (number | null)[] = step.perTooth ? teeth : [null];
    const visitSuffix = step.perTooth ? ` — سن ${toothList(teeth)}` : "";
    for (const toothCode of toothCodes) {
      drafts.push({
        serviceId: service.id,
        serviceName: service.name,
        category: step.category,
        toothCode,
        unitPriceMinor: price.minor,
        billingRule: step.billingRule,
        labWork: step.labWork,
        sessions: step.sessions.map((item, index) => ({
          title: item.title,
          minutes: item.minutes,
          afterDays: item.afterDays,
          visitKey: `${step.key}:${index}`,
          visitTitle: `${item.title}${visitSuffix}`,
        })),
      });
    }
  }

  if (drafts.length === 0) return { ok: false, message: "لم تبقَ خطوةٌ في الخطة — اختر خطوةً واحدة على الأقل." };
  return { ok: true, drafts };
}
