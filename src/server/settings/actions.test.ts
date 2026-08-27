import { describe, expect, it } from "vitest";

import { clinicSettingsSchema } from "@/server/settings/queries";

describe("clinicSettingsSchema", () => {
  const valid = {
    displayName: "مركز قلان",
    defaultRecallIntervalDays: "30",
    whatsappTemplateAr: "مرحبًا {name} من {center}",
    whatsappTemplateEn: "Hello {name} from {center}",
  };

  it("accepts valid input and coerces recall to number", () => {
    const result = clinicSettingsSchema.parse(valid);
    expect(result.defaultRecallIntervalDays).toBe(30);
    expect(result.displayName).toBe("مركز قلان");
  });

  it("accepts empty templates and display name (use defaults)", () => {
    const result = clinicSettingsSchema.parse({
      ...valid,
      displayName: "",
      whatsappTemplateAr: "",
      whatsappTemplateEn: "",
    });
    expect(result.displayName).toBe("");
  });

  it("rejects recall outside 1..365", () => {
    expect(
      clinicSettingsSchema.safeParse({ ...valid, defaultRecallIntervalDays: "0" })
        .success
    ).toBe(false);
    expect(
      clinicSettingsSchema.safeParse({ ...valid, defaultRecallIntervalDays: "366" })
        .success
    ).toBe(false);
    expect(
      clinicSettingsSchema.safeParse({ ...valid, defaultRecallIntervalDays: "2.5" })
        .success
    ).toBe(false);
  });

  it("rejects over-long values", () => {
    expect(
      clinicSettingsSchema.safeParse({ ...valid, displayName: "x".repeat(81) })
        .success
    ).toBe(false);
    expect(
      clinicSettingsSchema.safeParse({
        ...valid,
        whatsappTemplateAr: "ي".repeat(501),
      }).success
    ).toBe(false);
  });
});
