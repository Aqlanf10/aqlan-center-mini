import { describe, expect, it } from "vitest";
import {
  canonicalPatientPrefix,
  LEGACY_NUMBER_MAX,
  MANAGED_NUMBER_MAX,
  patientNumberDigits,
  patientNumberFloor,
} from "../lib/patient-numbering-input";

describe("patient numbering input canonicalization", () => {
  it("normalizes brw + ١٥٠٠ to BRW + 1500", () => {
    expect(canonicalPatientPrefix("brw")).toBe("BRW");
    expect(canonicalPatientPrefix("BRW")).toBe("BRW");
    expect(patientNumberDigits("١٥٠٠")).toBe("1500");
    expect(patientNumberDigits("٠١٥٠٠")).toBe("1500");
    expect(patientNumberDigits(" ۱۵۰۰ ")).toBe("1500");
  });

  it("rejects Unicode case-fold confusables, non-ASCII letters, and >6 character prefixes", () => {
    for (const bad of ["", " BRW", "BRW ", "ABCDEFG", "bß", "ı", "ſ", "ﬃ", "بر", "BRW-1", "P1"]) {
      expect(canonicalPatientPrefix(bad)).toBeNull();
    }
  });

  it("applies 7000 floor to P or legacy mode, and 1 floor to managed custom series", () => {
    expect(patientNumberFloor("P", false)).toBe(7000n);
    expect(patientNumberFloor("P", true)).toBe(7000n);
    expect(patientNumberFloor("BRW", false)).toBe(7000n);
    expect(patientNumberFloor("BRW", true)).toBe(1n);
    expect(MANAGED_NUMBER_MAX).toBe(999999999999999999n);
    expect(LEGACY_NUMBER_MAX).toBe(9223372036854775807n);
  });
});
