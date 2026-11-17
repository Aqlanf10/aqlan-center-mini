import type { MedicationTemplate } from "./prescription-medication-templates";
const source = { title: "AAPD Useful Medications", url: "https://www.aapd.org/globalassets/media/policies_guidelines/r_usefulmeds25.pdf", version: "2025–2026", section: "Amoxicillin, p.670" };
/** Review-only arithmetic profiles. Local product, dose, frequency and duration
 * are not preselected; no profile is connected to prescription application. */
export const MEDICATION_PREVIEW_PROFILES: readonly MedicationTemplate[] = ([8, 12] as const).flatMap(interval =>
  (["liquid", "solid"] as const).map(formKind => ({
    id: `amoxicillin-child-${interval}h-${formKind}`, genericName: "Amoxicillin", population: "child" as const,
    form: formKind === "liquid" ? "Oral suspension" : "Tablet (product reviewed)", formKind, strength: "",
    reviewStatus: "pending-owner-review" as const,
    indication: "اختيار الطبيب بعد تقييم عدوى سنية تستدعي المضاد؛ لا يعوض العلاج الموضعي",
    antibiotic: true,
    indicationOptions: ["عدوى سنية مع انتشار أو علامات جهازية — تقييم الطبيب موثق"],
    source, instructionsAr: "راجع الحساسية ووظائف الكلى والمنتج وخطة العلاج الموضعي؛ يحدد الطبيب مدة الطفل ولا تُنسخ مدة البالغ تلقائيًا.",
    instructionsEn: "Clinician review of allergy, renal function, product and local treatment required.",
    duration: "مدة يحددها الطبيب حسب استطباب الطفل، دون قيمة افتراضية", durationDays: { min: null, max: null },
    // Narrow first-preview scope, not a claim that older children cannot use the drug.
    ageMonths: { min: 3, minExclusive: true, max: 144, maxExclusive: true },
    weightKg: { min: 0, minExclusive: true, max: 40, maxExclusive: true },
    dosing: {
      basis: "mg/kg/day" as const, amountRange: interval === 8 ? { min: 20, max: 40 } : { min: 25, max: 45 },
      allowedIntervalsHours: [interval], minimumIntervalHours: interval, asNeeded: false,
      maxDosesPerRolling24Hours: 24 / interval, maxMgPerDose: interval === 8 ? 500 : 875,
      // Absolute daily cap derived from per-dose ceiling × scheduled count.
      maxMgPerDay: interval === 8 ? 1500 : 1750, maxMgPerKgPerDay: interval === 8 ? 40 : 45,
    },
  })));
