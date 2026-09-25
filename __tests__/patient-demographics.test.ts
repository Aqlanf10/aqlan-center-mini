import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATIENT_DEMOGRAPHICS_SQL } from "../lib/patient-demographics-schema";
import { ageFromBirthDate, validatePatient } from "../lib/patient";

const TODAY = "2026-09-25";

describe("patient demographics (P2-8)", () => {
  it("keeps migration 0018 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0018_patient_demographics.sql", "utf8").split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(lines.slice(index).join("\n").trim()).toBe(PATIENT_DEMOGRAPHICS_SQL.trim());
  });

  it("derives the birth year from a full date of birth and keeps guardian and ID", () => {
    const result = validatePatient({
      fullName: "سارة علي", birthDate: "2014-03-02", guardianName: "علي محمد",
      guardianPhone: "777123456", nationalId: "A123",
    }, TODAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      birthDate: "2014-03-02", birthYear: 2014, guardianName: "علي محمد",
      guardianPhone: "777123456", nationalId: "A123",
    });
  });

  it("refuses an impossible, future or contradicting date of birth", () => {
    expect(validatePatient({ fullName: "سارة علي", birthDate: "2014-02-30" }, TODAY)).toMatchObject({ ok: false, field: "birthDate" });
    expect(validatePatient({ fullName: "سارة علي", birthDate: "2027-01-01" }, TODAY)).toMatchObject({ ok: false, field: "birthDate" });
    expect(validatePatient({ fullName: "سارة علي", birthDate: "2014-03-02", birthYear: "2013" }, TODAY))
      .toMatchObject({ ok: false, field: "birthYear" });
  });

  it("all new fields stay optional", () => {
    const result = validatePatient({ fullName: "سارة علي" }, TODAY);
    expect(result.ok && result.value).toMatchObject({ birthDate: null, guardianName: null, guardianPhone: null, nationalId: null });
  });

  it("computes age in full years, not before the birthday", () => {
    expect(ageFromBirthDate("2014-09-26", TODAY)).toBe(11);
    expect(ageFromBirthDate("2014-09-25", TODAY)).toBe(12);
    expect(ageFromBirthDate(null, TODAY)).toBeNull();
  });
});
