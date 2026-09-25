import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATIENT_SOURCE_SQL } from "../lib/patient-source-schema";
import { validatePatient } from "../lib/patient";
import { PUBLIC_SETTING_KEYS, SETTING_DEFAULTS } from "../lib/settings";
import { validateTypedSetting } from "../lib/settings-validate";

describe("patient referral source (P3-8b)", () => {
  it("keeps migration 0022 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0022_patient_referral_source.sql", "utf8").split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(lines.slice(index).join("\n").trim()).toBe(PATIENT_SOURCE_SQL.trim());
  });

  it("validatePatient keeps the source and who referred, trimmed and bounded", () => {
    const result = validatePatient({
      fullName: "سارة أحمد", gender: "female", referralSource: "  توصية مريض ", referredBy: "والدة المريضة منى",
    }, "2026-09-25");
    expect(result.ok && result.value).toMatchObject({ referralSource: "توصية مريض", referredBy: "والدة المريضة منى" });
    const long = validatePatient({ fullName: "سارة أحمد", gender: "female", referralSource: "س".repeat(200) }, "2026-09-25");
    expect(long.ok && long.value.referralSource?.length).toBe(80);
  });

  it("the source list is a clinic setting shown to the editor, with a sensible default", () => {
    expect(SETTING_DEFAULTS["patients.referral_sources"].split(",")).toContain("توصية مريض");
    expect(PUBLIC_SETTING_KEYS).toContain("patients.referral_sources");
    expect(validateTypedSetting("patients.referral_sources", "توصية,,أخرى")).toContain("بلا عناصر فارغة");
    expect(validateTypedSetting("patients.referral_sources", "توصية مريض,طبيب")).toBeNull();
  });
});
