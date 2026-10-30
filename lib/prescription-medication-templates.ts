import type { RxItem } from "./prescription";

/** This catalog is deliberately separate from non-drug procedure templates.
 * Populate only from reviewed clinical sources; never recover legacy regimens. */
export interface MedicationTemplateSource {
  title: string;
  url: string;
  version: string;
  section: string;
}

export interface MedicationTemplate {
  id: string;
  genericName: string;
  population: "adult" | "child";
  form: string;
  strength: string;
  indication: string;
  antibiotic: boolean;
  source: MedicationTemplateSource;
  instructionsAr: string;
  instructionsEn: string;
  duration: string;
  /** Bounds must come from the reviewed regimen, not inferred from birthYear. */
  ageMonths: { min: number; max: number };
  dosing: {
    basis: "mg/dose" | "mg/kg/dose" | "mg/kg/day";
    amount: number;
    dosesPerDay: number;
    maxMgPerDose: number;
    maxMgPerDay: number;
    maxMgPerKgPerDay?: number;
  };
}

// Awaiting reviewed clinical references. No production doses or examples here.
export const MEDICATION_TEMPLATES: readonly MedicationTemplate[] = [];

export interface MedicationTemplateContext {
  ageMonths: number;
  weightKg?: number;
  /** Explicit confirmation of a current measured weight for this encounter. */
  currentWeightConfirmed: boolean;
  concentration?: { mg: number; ml: number };
  clinicalReviewConfirmed: boolean;
  indication: string;
}

export type TemplateCalculation =
  | { ok: false; message: string }
  | { ok: true; mgPerDose: number; mgPerDay: number; mlPerDose: number | null; item: RxItem };

const positive = (n: number) => Number.isFinite(n) && n > 0;

/** Pure calculator. Selecting a template never saves, signs or prints a prescription.
 * Down-round liquid volume, then recheck both limits using the administered dose. */
export function calculateMedicationTemplate(
  template: MedicationTemplate,
  context: MedicationTemplateContext,
): TemplateCalculation {
  const reject = (message: string): TemplateCalculation => ({ ok: false, message });
  if (!context.clinicalReviewConfirmed || !context.indication.trim()) {
    return reject("حدّد الاستطباب وراجع الحساسية والحالة والتداخلات قبل إضافة الدواء.");
  }
  if (!Number.isFinite(context.ageMonths) || context.ageMonths < 0 ||
      !Number.isFinite(template.ageMonths.min) || !Number.isFinite(template.ageMonths.max) ||
      template.ageMonths.min < 0 || template.ageMonths.max < template.ageMonths.min ||
      context.ageMonths < template.ageMonths.min || context.ageMonths > template.ageMonths.max) {
    return reject("أدخل عمرًا صريحًا ضمن نطاق القالب؛ لا يُستنتج العمر من سنة الميلاد.");
  }
  if (![template.source.title, template.source.url, template.source.version, template.source.section].every(s => s.trim())) {
    return reject("مصدر القالب وإصداره غير مكتملين.");
  }
  const d = template.dosing;
  if (![d.amount, d.dosesPerDay, d.maxMgPerDose, d.maxMgPerDay].every(positive) ||
      !Number.isInteger(d.dosesPerDay) || d.dosesPerDay > 24 ||
      !["mg/dose", "mg/kg/dose", "mg/kg/day"].includes(d.basis)) {
    return reject("قاعدة الجرعة أو حدودها غير صالحة.");
  }
  const needsWeight = template.population === "child" || d.basis !== "mg/dose";
  if (needsWeight && (!context.currentWeightConfirmed || !positive(context.weightKg ?? NaN) || context.weightKg! > 300)) {
    return reject("أدخل وزنًا مقاسًا حديثًا بالكيلوغرام وأكّد مراجعته لهذه الزيارة.");
  }
  if (template.population === "child" && !context.concentration) {
    return reject("أدخل تركيز المستحضر صراحة بوحدتي mg وmL.");
  }
  const concentration = context.concentration;
  if (concentration && (!positive(concentration.mg) || !positive(concentration.ml))) {
    return reject("تركيز المستحضر غير صالح؛ يلزم mg وmL أكبر من صفر.");
  }
  const requestedMg = d.basis === "mg/dose" ? d.amount
    : d.amount * context.weightKg! / (d.basis === "mg/kg/day" ? d.dosesPerDay : 1);
  if (!positive(requestedMg)) return reject("تعذّر حساب جرعة صالحة.");
  const weightDailyMax = d.maxMgPerKgPerDay === undefined ? Infinity
    : positive(d.maxMgPerKgPerDay) && context.currentWeightConfirmed && positive(context.weightKg ?? NaN)
      ? d.maxMgPerKgPerDay * context.weightKg! : NaN;
  const dailyMax = Math.min(d.maxMgPerDay, weightDailyMax);
  if (!positive(dailyMax) || requestedMg > d.maxMgPerDose || requestedMg * d.dosesPerDay > dailyMax) {
    return reject("الجرعة المختارة تتجاوز السقف لكل جرعة أو لكل يوم؛ عدّلها بعد المراجعة ولا تُخفض تلقائيًا.");
  }
  let mgPerDose = requestedMg;
  let mlPerDose: number | null = null;
  if (concentration) {
    // A 0.01 mL arithmetic precision is not a recommendation of measuring-device precision.
    // The clinician must review a measurable volume before prescribing.
    mlPerDose = Math.floor((mgPerDose * concentration.ml / concentration.mg) * 100) / 100;
    mgPerDose = mlPerDose * concentration.mg / concentration.ml;
  }
  const mgPerDay = mgPerDose * d.dosesPerDay;
  if (!positive(mgPerDose) || !positive(mgPerDay) ||
      mgPerDose > d.maxMgPerDose || mgPerDay > dailyMax) {
    return reject("الحجم المحسوب غير قابل للاستخدام أو تجاوز سقف الجرعة؛ راجع التركيز والجرعة.");
  }
  const doseLabel = Number(mgPerDose.toPrecision(12)).toString();
  return {
    ok: true, mgPerDose, mgPerDay, mlPerDose,
    item: {
      name: template.genericName,
      dose: concentration ? `${concentration.mg} mg / ${concentration.ml} mL` : template.strength,
      form: template.form,
      frequency: `${mlPerDose === null ? `${doseLabel} mg` : `${mlPerDose} mL (${doseLabel} mg)`} per dose; ${d.dosesPerDay} times daily`,
      duration: template.duration,
      instructions: template.instructionsAr,
      instructionsEn: template.instructionsEn,
    },
  };
}
