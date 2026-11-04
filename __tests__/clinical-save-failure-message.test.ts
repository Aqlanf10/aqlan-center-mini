import { describe, expect, it } from "vitest";
import { clinicalSaveFailureMessage } from "../lib/clinical-save-failure-message";

describe("clinical save failure guidance", () => {
  it.each(["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"])(
    "localizes browser transport error %s", (message) => {
      expect(clinicalSaveFailureMessage(new TypeError(message))).toBe("تعذّر الاتصال بالخادم.");
    },
  );
  it("preserves actionable validation and command-lock errors", () => {
    const message = "تحقق من حفظ المختبر السابق أولًا.";
    expect(clinicalSaveFailureMessage(new Error(message))).toBe(message);
  });
  it.each([undefined, null, "Failed to fetch", {}])("does not stringify an unknown failure", (reason) => {
    expect(clinicalSaveFailureMessage(reason)).toBe("تعذّر الاتصال بالخادم.");
  });
});
