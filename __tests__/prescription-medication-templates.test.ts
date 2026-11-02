import { describe, expect, it } from "vitest";
import { calculateMedicationTemplate, MEDICATION_TEMPLATES, type MedicationTemplate, type MedicationTemplateContext } from "@/lib/prescription-medication-templates";
import { MEDICATION_PREVIEW_PROFILES } from "@/lib/prescription-medication-preview";
// Synthetic arithmetic only, NOT treatment instructions.
const template: MedicationTemplate = {
  id: "synthetic-not-for-use", genericName: "SYNTHETIC", population: "child", form: "Synthetic liquid", formKind: "liquid", strength: "",
  reviewStatus: "pending-owner-review", indication: "synthetic", antibiotic: false, indicationOptions: ["synthetic"],
  source: { title: "Synthetic", url: "https://example.invalid", version: "test", section: "arithmetic" },
  instructionsAr: "للاختبار فقط", instructionsEn: "NOT FOR USE", duration: "clinician choice", durationDays: { min: 1, max: 7 },
  ageMonths: { min: 24, max: 120 }, weightKg: { min: 1, max: 40, maxExclusive: true },
  dosing: { basis: "mg/kg/dose", amountRange: { min: 1, max: 30 }, allowedIntervalsHours: [6, 8, 12], minimumIntervalHours: 6,
    asNeeded: false, maxDosesPerRolling24Hours: 4, maxMgPerDose: 100, maxMgPerDay: 300, maxMgPerKgPerDay: 15 },
};
const context: MedicationTemplateContext = {
  purpose: "synthetic-preview", ageMonths: 60, weightKg: 20, currentWeightConfirmed: true,
  concentration: { mg: 100, ml: 5 }, measuringIncrementMl: 0.1, productReviewed: true,
  selectedAmount: 3, intervalHours: 6, maxDoses24h: 4, durationDays: 3, durationReviewed: true,
  clinicalReviewConfirmed: true, indication: "synthetic", indicationRationale: "Synthetic review only",
  allergyReviewed: true, renalReviewed: true, localTreatmentPlanReviewed: true,
  priorDoses24h: { count: 0, totalMg: 0, hoursSinceLastDose: null }, plannedDoses24h: 4,
};
describe("review-only medication arithmetic", () => {
  it("has no clinically active seed", () => expect(MEDICATION_TEMPLATES).toEqual([]));
  it("distinguishes mg/kg/dose from mg/kg/day", () => {
    expect(calculateMedicationTemplate(template, context)).toMatchObject({ ok: true, mgPerDose: 60, mgPerDay: 240, mlPerDose: 3, previewOnly: true });
    expect(calculateMedicationTemplate({ ...template, dosing: { ...template.dosing, basis: "mg/kg/day" } }, { ...context, measuringIncrementMl: 0.05 })).toMatchObject({ ok: true, mgPerDose: 15, mgPerDay: 60, mlPerDose: 0.75 });
  });
  it.each([0, -1, NaN, Infinity, 40, 50])("rejects invalid/out-of-profile weight %s", weightKg => {
    expect(calculateMedicationTemplate(template, { ...context, weightKg }).ok).toBe(false);
  });
  it.each([
    { currentWeightConfirmed: false }, { ageMonths: 0 }, { ageMonths: NaN }, { weightKg: undefined },
    { concentration: undefined }, { concentration: { mg: 0, ml: 5 } }, { concentration: { mg: 100, ml: 0 } },
    { measuringIncrementMl: 0 }, { selectedAmount: NaN }, { selectedAmount: 31 }, { intervalHours: 4 },
    { maxDoses24h: 0 }, { maxDoses24h: 5 }, { durationDays: 0 }, { durationDays: 8 },
    { clinicalReviewConfirmed: false }, { indication: "unspecified" }, { indicationRationale: "" },
    { productReviewed: false }, { renalReviewed: false }, { allergyReviewed: false },
  ])("requires explicit complete context %j", patch => expect(calculateMedicationTemplate(template, { ...context, ...patch }).ok).toBe(false));
  it("rejects missing child weight-based daily cap and unresolved age scope", () => {
    expect(calculateMedicationTemplate({ ...template, dosing: { ...template.dosing, maxMgPerKgPerDay: undefined } }, context).ok).toBe(false);
    expect(calculateMedicationTemplate({ ...template, ageMonths: { min: null, max: 144 } }, context).ok).toBe(false);
  });
  it("reports requested vs rounded dose using the actual measuring increment", () => {
    const result = calculateMedicationTemplate(template, { ...context, selectedAmount: 2.83, measuringIncrementMl: 0.5 });
    expect(result).toMatchObject({ ok: true, requestedMgPerDose: 56.6, mgPerDose: 60, mlPerDose: 3, roundingChanged: true });
  });
  it("rejects rounding above the ceiling and pre-rounding excess", () => {
    expect(calculateMedicationTemplate(template, { ...context, selectedAmount: 3.7, measuringIncrementMl: 1 }).ok).toBe(false);
    expect(calculateMedicationTemplate(template, { ...context, selectedAmount: 4 }).ok).toBe(false);
  });
  it("supports child tablets without forcing liquid concentration; adult liquid still requires it", () => {
    expect(calculateMedicationTemplate({ ...template, formKind: "solid" }, { ...context, concentration: undefined, solid: { mgPerUnit: 20, incrementUnits: 1 } })).toMatchObject({ ok: true, unitsPerDose: 3, mlPerDose: null });
    expect(calculateMedicationTemplate({ ...template, population: "adult" }, { ...context, concentration: undefined }).ok).toBe(false);
  });
  it("checks minimum interval and prior/planned rolling-24-hour count and total", () => {
    expect(calculateMedicationTemplate(template, { ...context, priorDoses24h: { count: 1, totalMg: 60, hoursSinceLastDose: 2 }, plannedDoses24h: 3 }).ok).toBe(false);
    expect(calculateMedicationTemplate(template, { ...context, priorDoses24h: { count: 1, totalMg: 160, hoursSinceLastDose: 6 }, plannedDoses24h: 3 }).ok).toBe(false);
    expect(calculateMedicationTemplate(template, { ...context, priorDoses24h: { count: 1, totalMg: 60, hoursSinceLastDose: 6 }, plannedDoses24h: 4 }).ok).toBe(false);
    expect(calculateMedicationTemplate(template, { ...context, priorDoses24h: { count: 1, totalMg: 60, hoursSinceLastDose: 6 }, plannedDoses24h: 3 })).toMatchObject({ ok: true, rolling24hMg: 240 });
  });
  it("PRN cannot exceed allowed daily count or interval capacity", () => {
    const prn = { ...template, dosing: { ...template.dosing, asNeeded: true } };
    expect(calculateMedicationTemplate(prn, { ...context, maxDoses24h: 5 }).ok).toBe(false);
    expect(calculateMedicationTemplate(prn, { ...context, intervalHours: 12, maxDoses24h: 4 }).ok).toBe(false);
  });
  it.each([[250, 4], [125, 8]])("30 mg/kg/day on synthetic 20kg, 3 doses, %s mg/5mL", (mg, mlPerDose) => {
    const synthetic = { ...template, dosing: { ...template.dosing, basis: "mg/kg/day" as const, maxMgPerDose: 500, maxMgPerDay: 1500, maxMgPerKgPerDay: 40 } };
    expect(calculateMedicationTemplate(synthetic, { ...context, selectedAmount: 30, intervalHours: 8, maxDoses24h: 3, plannedDoses24h: 3, concentration: { mg, ml: 5 } })).toMatchObject({ ok: true, mgPerDose: 200, mlPerDose });
  });
  it("all clinical preview profiles are gated, sourced, non-PRN and have explicit strict bounds", () => {
    for (const p of MEDICATION_PREVIEW_PROFILES) {
      expect(p.reviewStatus).toBe("pending-owner-review"); expect(p.dosing.asNeeded).toBe(false);
      expect(p.weightKg).toMatchObject({ max: 40, maxExclusive: true });
      expect(p.ageMonths).toMatchObject({ min: 3, minExclusive: true });
      expect(p.dosing.maxMgPerKgPerDay).toBeGreaterThan(0);
      expect(calculateMedicationTemplate(p, { ...context, ageMonths: 3 }).ok).toBe(false);
    }
  });
});
