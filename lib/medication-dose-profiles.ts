import research from './medication-dose-reference-data.json';

/** Display-only source records, never settings seeds, approvals or prescriptions.
 * Numerical calculation is allowed only by an explicit reviewed shape below.
 * No rule is inferred by parsing an Arabic population description or a JSON label. */
export const DOSE_REFERENCE_VERSION = research.version;
export const DOSE_REFERENCES = research.profiles;
export const DOSE_REFERENCE_SOURCES = research.sources;
export const DOSE_REFERENCE_WARNINGS = research.warnings;
export type DoseProfileId = string;
export type DoseBasis = 'mg/dose' | 'mg/kg/dose' | 'mg/kg/day';
export interface DoseCalculationRule {
  profileId: string;
  medicationId: 'paracetamol' | 'amoxicillin';
  basis: DoseBasis;
  scheduleKind: 'times-per-day' | 'prn-max' | 'fixed-interval';
  range: readonly [number, number];
  ageMonths: { min: number; minExclusive?: boolean; maxExclusive?: number };
  weightBelowKg?: number;
  weightRequired: boolean;
  administrations: readonly number[];
  minimumIntervalHours: number;
  maximumIntervalHours?: number;
  singleMaxMg?: number;
  dailyMaxMg?: number;
  dailyMaxMgPerKg?: number;
  requiresLabelSingleMax?: boolean;
  antibiotic: boolean;
  sourceDurationDays?: number;
  /** Conservative app scope, not a claim that the source forbids younger ages. */
  scopeNote: string;
}
const rules: readonly DoseCalculationRule[] = [
  { profileId:'paracetamol-adult-sdcep', medicationId:'paracetamol', basis:'mg/dose', scheduleKind:'times-per-day', range:[1000,1000],
    ageMonths:{min:216}, weightRequired:true, administrations:[4], minimumIntervalHours:4,
    singleMaxMg:1000, dailyMaxMg:4000, antibiotic:false, sourceDurationDays:5,
    scopeNote:'مثال SDCEP للبالغ فقط؛ سن18 حد نطاق التطبيق. وزن أقل من50kg أو حالة خاصة يحتاج مراجعة يدوية، وليس هذا المثال.' },
  { profileId:'paracetamol-child-aapd', medicationId:'paracetamol', basis:'mg/kg/dose', scheduleKind:'prn-max', range:[10,15],
    ageMonths:{min:6,maxExclusive:144}, weightRequired:true, administrations:[1,2,3,4,5,6], minimumIntervalHours:4, maximumIntervalHours:6,
    singleMaxMg:1000, dailyMaxMgPerKg:75, dailyMaxMg:4000, requiresLabelSingleMax:true, antibiotic:false,
    scopeNote:'نطاق التطبيق المحافظ من6أشهر إلى أقل من12سنة، مع تحقق عمر المنتج. يلزم سقف مفرد موثق من النشرة؛ لا نستنتجه من السقف اليومي.' },
  { profileId:'amoxicillin-child-aapd-q8', medicationId:'amoxicillin', basis:'mg/kg/day', scheduleKind:'fixed-interval', range:[20,40],
    ageMonths:{min:3,minExclusive:true,maxExclusive:216}, weightBelowKg:40, weightRequired:true,
    administrations:[3], minimumIntervalHours:8, singleMaxMg:500, antibiotic:true,
    scopeNote:'أكبر من3أشهر وأقل من40kg؛ جرعة يومية تقسم3، والمدة والاستطباب يحددهما الطبيب. 40kg بالضبط غير مشمول.' },
  { profileId:'amoxicillin-child-aapd-q12', medicationId:'amoxicillin', basis:'mg/kg/day', scheduleKind:'fixed-interval', range:[25,45],
    ageMonths:{min:3,minExclusive:true,maxExclusive:216}, weightBelowKg:40, weightRequired:true,
    administrations:[2], minimumIntervalHours:12, singleMaxMg:875, antibiotic:true,
    scopeNote:'نظام مستقل كل12ساعة؛ لا يستبدل التكرار داخل نظام8ساعات. يلزم منتج ومدة واستطباب مراجعون؛ راجع قيود قوة875 عند القصور الكلوي.' },
];
for (const rule of rules) { Object.freeze(rule.range); Object.freeze(rule.ageMonths); Object.freeze(rule.administrations); Object.freeze(rule); }
export function doseCalculationRule(id: string): DoseCalculationRule | undefined {
  return rules.find(rule=>rule.profileId===id);
}
export function doseReference(id: string) { return DOSE_REFERENCES.find(profile=>profile.id===id); }
export function doseProfileCalculationBlocker(id: string): string | null {
  if (!doseReference(id)) return 'مرجع غير معروف.';
  if (doseCalculationRule(id)) return null;
  return 'هذا الملف متاح لقراءة الجرعة والتعليمات واختيار نظامه، لكن تحويله العددي لم يُراجع في هذه المرحلة؛ لا تُستنتج قواعده من النص. تبقى تعبئة الطبيب اليدوية منفصلة.';
}
