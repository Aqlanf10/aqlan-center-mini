import { describe, expect, it } from "vitest";
import { calculateMedicationTemplate, MEDICATION_TEMPLATES, type MedicationTemplate, type MedicationTemplateContext } from "@/lib/prescription-medication-templates";

// Synthetic arithmetic fixtures, NOT drug guidance or production regimens.
const template: MedicationTemplate = {
  id: "synthetic-not-for-treatment", genericName: "SYNTHETIC NOT FOR USE", population: "child",
  form: "Synthetic liquid", strength: "", indication: "synthetic", antibiotic: false,
  source: { title: "Arithmetic fixture", url: "https://example.invalid", version: "test", section: "test" },
  instructionsAr: "للاختبار فقط", instructionsEn: "NOT FOR USE", duration: "synthetic",
  ageMonths: { min: 24, max: 120 },
  dosing: { basis: "mg/kg/dose", amount: 3, dosesPerDay: 4, maxMgPerDose: 100, maxMgPerDay: 300 },
};
const context: MedicationTemplateContext = {
  ageMonths: 60, weightKg: 20, currentWeightConfirmed: true,
  concentration: { mg: 100, ml: 5 }, clinicalReviewConfirmed: true, indication: "synthetic",
};

describe("explicit medication template arithmetic", () => {
  it("has no clinical seed pending source review", () => expect(MEDICATION_TEMPLATES).toEqual([]));
  it("distinguishes per-dose from per-day weight calculations", () => {
    const perDose = calculateMedicationTemplate(template, context);
    const perDay = calculateMedicationTemplate({ ...template, dosing: { ...template.dosing, basis: "mg/kg/day" } }, context);
    expect(perDose).toMatchObject({ ok: true, mgPerDose: 60, mgPerDay: 240, mlPerDose: 3 });
    expect(perDay).toMatchObject({ ok: true, mgPerDose: 15, mgPerDay: 60, mlPerDose: 0.75 });
  });
  it.each([0, -1, NaN, Infinity, 301])("rejects invalid weight %s", weightKg => {
    expect(calculateMedicationTemplate(template, { ...context, weightKg }).ok).toBe(false);
  });
  it.each([
    { currentWeightConfirmed: false }, { weightKg: undefined }, { ageMonths: NaN },
    { ageMonths: 12 }, { concentration: undefined }, { concentration: { mg: 0, ml: 5 } },
    { concentration: { mg: 100, ml: 0 } }, { clinicalReviewConfirmed: false }, { indication: " " },
  ])("requires complete explicit patient context %j", patch => {
    expect(calculateMedicationTemplate(template, { ...context, ...patch }).ok).toBe(false);
  });
  it("checks limits and rounds liquid down without exceeding them", () => {
    const result = calculateMedicationTemplate(template, { ...context, weightKg: 25, concentration: { mg: 700, ml: 3 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mgPerDose).toBeLessThanOrEqual(75);
      expect(result.mgPerDay).toBeLessThanOrEqual(300);
      expect(result.mlPerDose).toBe(0.32);
    }
  });
  it.each([0, NaN, Infinity, -1, 1.5, 25])("rejects invalid dose frequency %s", dosesPerDay => {
    expect(calculateMedicationTemplate({ ...template, dosing: { ...template.dosing, dosesPerDay } }, context).ok).toBe(false);
  });
  it("rejects missing source and cannot mutate the template or context", () => {
    const before = structuredClone({ template, context });
    calculateMedicationTemplate(template, context);
    expect({ template, context }).toEqual(before);
    expect(calculateMedicationTemplate({ ...template, source: { ...template.source, version: "" } }, context).ok).toBe(false);
  });
});

it("rejects an excessive chosen regimen instead of silently reducing it", () => {
  expect(calculateMedicationTemplate(template, { ...context, weightKg: 100 }).ok).toBe(false);
  expect(calculateMedicationTemplate({ ...template, dosing: { ...template.dosing, maxMgPerKgPerDay: 10 } }, context).ok).toBe(false);
});
it.each([[250, 4], [125, 8]])("uses explicit label strength %s mg/5 mL", (mg, mlPerDose) => {
  const synthetic = { ...template, dosing: { ...template.dosing, basis: "mg/kg/day" as const, amount: 30, dosesPerDay: 3, maxMgPerDose: 300, maxMgPerDay: 900 } };
  expect(calculateMedicationTemplate(synthetic, { ...context, concentration: { mg, ml: 5 } })).toMatchObject({ ok: true, mgPerDose: 200, mlPerDose });
});
