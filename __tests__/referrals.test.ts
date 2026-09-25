import { describe, expect, it } from "vitest";
import { checkReferralClose, checkReferralDraft, isFdiTooth, normalizeTeeth } from "@/lib/referrals";

/** (P3-8) الإحالات الصادرة — التحقق الخالص. */

describe("normalizeTeeth", () => {
  it("يقبل الفواصل العربية والمسافات والأرقام الهندية، بلا تكرار وبترتيب الكتابة", () => {
    expect(normalizeTeeth("14، 24 ٣٤-44, 14")).toEqual({ ok: true, value: "14, 24, 34, 44" });
  });

  it("الفارغ لا أسنان", () => {
    expect(normalizeTeeth("  ")).toEqual({ ok: true, value: null });
  });

  it.each(["19", "49", "56", "99", "1", "140"])("يرفض %s — ليس رقم FDI", (token) => {
    const result = normalizeTeeth(token);
    expect(result.ok).toBe(false);
  });

  it("FDI: الدائمة 11–48 واللبنية 51–85", () => {
    expect([11, 18, 48, 51, 55, 85].every(isFdiTooth)).toBe(true);
    expect([10, 19, 50, 56, 86, 91].some(isFdiTooth)).toBe(false);
  });
});

describe("checkReferralDraft", () => {
  const valid = { toName: "د. سامي — جراحة الفكين", toSpecialty: "oral_surgery", reason: "قلع الضواحك الأولى", teeth: "14 24 34 44" };

  it("المسودة السليمة", () => {
    expect(checkReferralDraft(valid)).toEqual({
      ok: true,
      value: { toName: "د. سامي — جراحة الفكين", toSpecialty: "oral_surgery", reason: "قلع الضواحك الأولى", teeth: "14, 24, 34, 44", urgency: "routine" },
    });
  });

  it("رسائل عربية لكل نقص", () => {
    expect(checkReferralDraft({ ...valid, toName: "" })).toMatchObject({ ok: false, message: expect.stringContaining("المحال إليه") });
    expect(checkReferralDraft({ ...valid, toSpecialty: "magic" })).toMatchObject({ ok: false, message: expect.stringContaining("تخصص") });
    expect(checkReferralDraft({ ...valid, reason: "" })).toMatchObject({ ok: false, message: expect.stringContaining("سبب الإحالة") });
    expect(checkReferralDraft({ ...valid, teeth: "14 99" })).toMatchObject({ ok: false, message: expect.stringContaining("FDI") });
    expect(checkReferralDraft({ ...valid, urgency: "yesterday" })).toMatchObject({ ok: false });
  });
});

describe("checkReferralClose", () => {
  it("الاكتمال بنتيجةٍ اختيارية، والإلغاء بسببٍ إلزامي", () => {
    expect(checkReferralClose({ action: "complete" })).toEqual({ ok: true, value: { status: "completed", note: null } });
    expect(checkReferralClose({ action: "complete", note: "قُلعت الأربعة" })).toEqual({ ok: true, value: { status: "completed", note: "قُلعت الأربعة" } });
    expect(checkReferralClose({ action: "cancel", note: "" })).toMatchObject({ ok: false, message: expect.stringContaining("سبب") });
    expect(checkReferralClose({ action: "reopen" })).toMatchObject({ ok: false });
  });
});
