import { describe, it, expect } from "vitest";
import { CONSENT_TEMPLATES, getConsentTemplate } from "../lib/consent-templates";

describe("نماذج الإقرارات والموافقات الطبية السريرية (Consent Templates)", () => {
  it("تحتوي على الإقرارات الخمسة الأساسية لمركز الأسنان", () => {
    expect(CONSENT_TEMPLATES.length).toBeGreaterThanOrEqual(5);

    const surgical = getConsentTemplate("surgical_extraction");
    expect(surgical).not.toBeNull();
    expect(surgical?.title).toContain("خلع");
    expect(surgical?.risks.length).toBeGreaterThan(0);
    expect(surgical?.postOpInstructions.length).toBeGreaterThan(0);

    const endo = getConsentTemplate("root_canal");
    expect(endo).not.toBeNull();
    expect(endo?.title).toContain("عصب");

    const implant = getConsentTemplate("dental_implant");
    expect(implant).not.toBeNull();
    expect(implant?.title).toContain("زراعة");

    const whitening = getConsentTemplate("teeth_whitening");
    expect(whitening).not.toBeNull();

    const ortho = getConsentTemplate("orthodontics");
    expect(ortho).not.toBeNull();
  });

  it("يُرجع null عند طلب معرف غير موجود", () => {
    expect(getConsentTemplate("non_existent")).toBeNull();
  });
});
