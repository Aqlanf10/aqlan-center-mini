import type { RxItem } from "./prescription";
export interface MedicationTemplateSource { title: string; url: string; version: string; section: string }
export interface MedicationTemplate {
  id: string; genericName: string; population: "adult" | "child";
  form: string; formKind: "liquid" | "solid"; strength: string;
  reviewStatus: "pending-owner-review";
  indication: string; antibiotic: boolean; indicationOptions: readonly string[];
  source: MedicationTemplateSource; instructionsAr: string; instructionsEn: string;
  duration: string; durationDays: { min: number | null; max: number | null };
  /** null minimum means product/age scope still unresolved: do not calculate. */
  ageMonths: { min: number | null; max: number | null; minExclusive?: boolean; maxExclusive?: boolean };
  weightKg: { min: number; max: number | null; minExclusive?: boolean; maxExclusive?: boolean };
  dosing: {
    basis: "mg/dose" | "mg/kg/dose" | "mg/kg/day";
    amountRange: { min: number; max: number };
    allowedIntervalsHours: readonly number[]; minimumIntervalHours: number;
    asNeeded: boolean; maxDosesPerRolling24Hours: number;
    maxMgPerDose: number; maxMgPerDay: number; maxMgPerKgPerDose?: number; maxMgPerKgPerDay?: number;
  };
}
/** There is no clinically activated seed. Preview profiles live separately. */
export const MEDICATION_TEMPLATES: readonly MedicationTemplate[] = [];
export interface MedicationTemplateContext {
  purpose: "synthetic-preview";
  ageMonths: number; weightKg?: number; currentWeightConfirmed: boolean;
  concentration?: { mg: number; ml: number };
  measuringIncrementMl?: number;
  solid?: { mgPerUnit: number; incrementUnits: number };
  productReviewed: boolean; selectedAmount: number; intervalHours: number; maxDoses24h: number;
  durationDays: number; durationReviewed: boolean;
  clinicalReviewConfirmed: boolean; indication: string; indicationRationale: string;
  allergyReviewed: boolean; renalReviewed: boolean; localTreatmentPlanReviewed: boolean;
  /** Explicit rolling-window review, not an automatic administration schedule. */
  priorDoses24h: { count: number; totalMg: number; hoursSinceLastDose: number | null };
  plannedDoses24h: number;
}
export type TemplateCalculation =
  | { ok: false; message: string }
  | { ok: true; previewOnly: true; requestedMgPerDose: number; mgPerDose: number; mgPerDay: number;
      rolling24hMg: number; mlPerDose: number | null; unitsPerDose: number | null;
      roundingChanged: boolean; roundingMessage: string; item: RxItem };
const positive = (n: number) => Number.isFinite(n) && n > 0;
const inRange = (n: number, r: { min: number | null; max: number | null; minExclusive?: boolean; maxExclusive?: boolean }) =>
  Number.isFinite(n) && r.min !== null && Number.isFinite(r.min) && (r.minExclusive ? n > r.min : n >= r.min)
  && (r.max === null || (Number.isFinite(r.max) && r.max >= r.min && (r.maxExclusive ? n < r.max : n <= r.max)));

/** Arithmetic preview only. Never validates the clinical indication or saves,
 * signs, prints, activates a profile, or silently changes a selected regimen. */
export function calculateMedicationTemplate(t: MedicationTemplate, c: MedicationTemplateContext): TemplateCalculation {
  const reject = (message: string): TemplateCalculation => ({ ok: false, message });
  if (c.purpose !== "synthetic-preview" || t.reviewStatus !== "pending-owner-review") return reject("هذه الحاسبة للمعاينة الاصطناعية فقط؛ لا اعتماد سريري.");
  if (!c.productReviewed || !c.clinicalReviewConfirmed || !c.allergyReviewed || !c.renalReviewed || !c.durationReviewed)
    return reject("يلزم مراجعة المنتج والحالة والحساسية والكلى والمدة؛ تبقى الكتابة اليدوية للطبيب خارج هذا القالب.");
  if (!t.indicationOptions.includes(c.indication) || !c.indicationRationale.trim() || (t.antibiotic && !c.localTreatmentPlanReviewed))
    return reject("اختر استطبابًا من مرجع الملف ووثّق تقييم الطبيب وخطة العلاج الموضعي؛ الحاسبة لا تثبت صحة الاستطباب.");
  if (!inRange(c.ageMonths, t.ageMonths) || c.ageMonths < 0) return reject("العمر خارج نطاق الملف أو حد العمر الأدنى للمنتج غير موثق؛ مراجعة يدوية.");
  if ((!c.currentWeightConfirmed || !positive(c.weightKg ?? NaN) || !inRange(c.weightKg!, t.weightKg)))
    return reject("يلزم وزن مقاس حديث ضمن حدود الملف؛ لا يُستنتج من العمر.");
  if (![t.source.title, t.source.url, t.source.version, t.source.section].every(s => s.trim())) return reject("مصدر الملف وإصداره غير مكتملين.");
  const d = t.dosing;
  if (![d.amountRange.min, d.amountRange.max, d.maxMgPerDose, d.maxMgPerDay, d.minimumIntervalHours, d.maxDosesPerRolling24Hours].every(positive)
    || d.amountRange.max < d.amountRange.min || !Number.isInteger(d.maxDosesPerRolling24Hours)
    || d.allowedIntervalsHours.length === 0 || !d.allowedIntervalsHours.every(positive) || (t.antibiotic && d.asNeeded)
    || !["mg/dose", "mg/kg/dose", "mg/kg/day"].includes(d.basis)
    || (t.population === "child" && !positive(d.maxMgPerKgPerDay ?? NaN))
    || (d.maxMgPerKgPerDose !== undefined && !positive(d.maxMgPerKgPerDose))) return reject("ملف الجرعة ناقص أو سقوفه غير صالحة.");
  if (!positive(c.selectedAmount) || c.selectedAmount < d.amountRange.min || c.selectedAmount > d.amountRange.max) return reject("اختر مقدار الجرعة صراحة ضمن النطاق المرجعي.");
  if (!d.allowedIntervalsHours.includes(c.intervalHours) || !positive(c.intervalHours) || c.intervalHours < d.minimumIntervalHours
    || !Number.isInteger(c.maxDoses24h) || c.maxDoses24h < 1 || c.maxDoses24h > d.maxDosesPerRolling24Hours
    || c.maxDoses24h > Math.floor(24 / c.intervalHours)
    || (!d.asNeeded && c.maxDoses24h !== 24 / c.intervalHours)) return reject("الفاصل وعدد الجرعات في أي 24 ساعة غير متوافقين مع الملف.");
  if (!positive(c.durationDays) || !Number.isInteger(c.durationDays)
    || (t.durationDays.min !== null && c.durationDays < t.durationDays.min)
    || (t.durationDays.max !== null && c.durationDays > t.durationDays.max)) return reject("حدد المدة صراحة حسب الاستطباب والمرجع؛ لا مدة تلقائية.");
  const prior = c.priorDoses24h;
  if (!prior || !Number.isInteger(prior.count) || prior.count < 0 || !Number.isFinite(prior.totalMg) || prior.totalMg < 0
    || (prior.count === 0 ? prior.totalMg !== 0 : !positive(prior.totalMg))
    || !Number.isInteger(c.plannedDoses24h) || c.plannedDoses24h < 1
    || prior.count + c.plannedDoses24h > c.maxDoses24h
    || (prior.count > 0 && (!Number.isFinite(prior.hoursSinceLastDose) || prior.hoursSinceLastDose! < c.intervalHours)))
    return reject("راجع الجرعات السابقة والفاصل الأخير ومجموع الجرعات المخطط لها في نافذة 24 ساعة.");
  const requestedMg = d.basis === "mg/dose" ? c.selectedAmount : c.selectedAmount * c.weightKg! / (d.basis === "mg/kg/day" ? c.maxDoses24h : 1);
  const doseMax = Math.min(d.maxMgPerDose, d.maxMgPerKgPerDose === undefined ? Infinity : d.maxMgPerKgPerDose * c.weightKg!);
  const dailyMax = Math.min(d.maxMgPerDay, d.maxMgPerKgPerDay === undefined ? Infinity : d.maxMgPerKgPerDay * c.weightKg!);
  const withinCaps = (mg: number) => positive(mg) && positive(doseMax) && positive(dailyMax) && mg <= doseMax
    && mg * c.maxDoses24h <= dailyMax && prior.totalMg + mg * c.plannedDoses24h <= dailyMax;
  if (!withinCaps(requestedMg)) return reject("الجرعة المطلوبة تتجاوز سقف الجرعة أو اليوم أو نافذة 24 ساعة؛ لا خفض تلقائي.");
  let mlPerDose: number | null = null, unitsPerDose: number | null = null, mgPerDose: number;
  if (t.formKind === "liquid") {
    if (!c.concentration || !positive(c.concentration.mg) || !positive(c.concentration.ml) || !positive(c.measuringIncrementMl ?? NaN))
      return reject("السائل يحتاج تركيز mg لكل mL وخطوة أداة القياس بوحدة mL، للبالغ والطفل.");
    const requestedMl = requestedMg * c.concentration.ml / c.concentration.mg;
    mlPerDose = Number((Math.round(requestedMl / c.measuringIncrementMl!) * c.measuringIncrementMl!).toPrecision(12));
    mgPerDose = mlPerDose * c.concentration.mg / c.concentration.ml;
  } else if (t.formKind === "solid") {
    if (!c.solid || !positive(c.solid.mgPerUnit) || !positive(c.solid.incrementUnits) || c.solid.incrementUnits > 1)
      return reject("القرص يحتاج قوة mg للوحدة وخطوة تقسيم مؤكدة من المنتج؛ لا يُطلب تركيز شراب.");
    unitsPerDose = Number((Math.round(requestedMg / c.solid.mgPerUnit / c.solid.incrementUnits) * c.solid.incrementUnits).toPrecision(12));
    mgPerDose = unitsPerDose * c.solid.mgPerUnit;
  } else return reject("الشكل الدوائي غير مدعوم في الملف.");
  const rangeFactor = d.basis === "mg/dose" ? 1 : c.weightKg! / (d.basis === "mg/kg/day" ? c.maxDoses24h : 1);
  if (mgPerDose < d.amountRange.min * rangeFactor || mgPerDose > d.amountRange.max * rangeFactor) return reject("التقريب يخرج الجرعة عن نطاق الملف؛ راجع أداة القياس والمنتج يدويًا.");
  if (!withinCaps(mgPerDose)) return reject("التقريب وفق أداة القياس يتجاوز السقف أو يعطي جرعة صفرية؛ راجع المنتج والخطوة يدويًا.");
  const changed = Math.abs(mgPerDose - requestedMg) > Number.EPSILON * Math.max(mgPerDose, requestedMg) * 8;
  const doseLabel = Number(mgPerDose.toPrecision(12)).toString();
  return { ok: true, previewOnly: true, requestedMgPerDose: requestedMg, mgPerDose,
    mgPerDay: mgPerDose * c.maxDoses24h, rolling24hMg: prior.totalMg + mgPerDose * c.plannedDoses24h,
    mlPerDose, unitsPerDose, roundingChanged: changed,
    roundingMessage: changed ? `تغيّر المقدار بالتقريب من ${requestedMg} mg إلى ${doseLabel} mg؛ راجع الفرق وأداة القياس، ولا تُضاف النتيجة للوصفة.` : "لم تتغير الجرعة بالتقريب؛ هذه معاينة فقط.",
    item: { name: t.genericName, dose: t.formKind === "liquid" ? `${c.concentration!.mg} mg / ${c.concentration!.ml} mL` : `${c.solid!.mgPerUnit} mg/unit`, form: t.form,
      frequency: `${mlPerDose === null ? `${unitsPerDose} unit(s)` : `${mlPerDose} mL`} (${doseLabel} mg) per dose; every ${c.intervalHours} hours${d.asNeeded ? " as needed" : ""}; max ${c.maxDoses24h} doses in any 24 hours`,
      duration: `${c.durationDays} days (clinician selected)`, instructions: t.instructionsAr, instructionsEn: t.instructionsEn } };
}
