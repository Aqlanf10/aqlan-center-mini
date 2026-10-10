import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGNOSIS_CHOICE_GROUPS } from "../lib/diagnosis-choice-options";

const source = readFileSync("components/PatientDiagnosis.tsx", "utf8");
describe("case diagnosis choice boundaries", () => {
  it("keeps the main1878 patient/case/permission read, writer and history code byte-identical", () => {
    const start = source.indexOf("const READ_TIMEOUT_MS =");
    const end = source.indexOf("function DiagnosisForm(", start);
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    expect(createHash("sha256").update(source.slice(start, end)).digest("hex"))
      .toBe("85e504adeb5112baa10aa2c629fc03c96b88eb101ec7407d0ac61aeb8b7f30ca");
  });
  it("retains the existing blank partial revision and exact six-key versioned submission", () => {
    const form = source.slice(source.indexOf("function DiagnosisForm("));
    expect(form.match(/useState\(""\)/g)).toHaveLength(7);
    expect(form).toContain("onSave({ skeletal, dental, crowding, overjet, bite, note }, label)");
    expect(form).not.toContain("current.content");
    expect(form.match(/<DiagnosisChoiceField/g)).toHaveLength(4);
    expect(form).toContain('aria-label="البعد الأفقي"');
    expect(form).toContain("Overjet — البعد الأفقي (مم)");
  });
  it("has only explicit descriptive string choices, no numeric Overjet preset or normal default", () => {
    expect(Object.keys(DIAGNOSIS_CHOICE_GROUPS).sort()).toEqual(["bite", "crowding", "dental", "skeletal"]);
    for (const groups of Object.values(DIAGNOSIS_CHOICE_GROUPS)) {
      const values = groups.flatMap(group => group.options.map(option => option.value));
      expect(new Set(values).size).toBe(values.length);
      expect(values.every(value => value.trim() === value && value.length > 0 && value.length <= 200)).toBe(true);
      expect(values.some(value => /طبيعي|سليم|normal|healthy/i.test(value))).toBe(false);
    }
  });
});
