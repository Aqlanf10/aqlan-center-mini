import { describe, expect, it } from "vitest";
import {
  canSign, conditionForCategory, formatAddendum, procedureTotal, visitTotal,
} from "../lib/clinical";

describe("ربط الإجراء بالمخطط السني", () => {
  it("الحشوة المنفَّذة تصير حشوةً على المخطط بلا تسجيل ثانٍ", () => {
    expect(conditionForCategory("filling")).toBe("filling");
    expect(conditionForCategory("rct")).toBe("rct");
    expect(conditionForCategory("extraction")).toBe("extracted");
  });

  it("الخدمات التي لا أثر لها على سن لا تلمس المخطط", () => {
    expect(conditionForCategory("consultation")).toBeNull();
    expect(conditionForCategory(null)).toBeNull();
  });
});

describe("مجموع الزيارة", () => {
  it("هو نفسه مجموع الفاتورة — فلا رقمان لعمل واحد", () => {
    expect(visitTotal([
      { quantity: 2, unitPriceMinor: 15000 },
      { quantity: 1, unitPriceMinor: 40000 },
    ])).toBe(70000);
  });

  it("لا يقبل كمية ولا سعرًا سالبًا", () => {
    expect(procedureTotal(-3, 10000)).toBe(0);
    expect(procedureTotal(2, -10000)).toBe(0);
    expect(visitTotal([])).toBe(0);
  });
});

describe("توقيع الزيارة", () => {
  const base = { status: "open" as const, procedures: [], diagnosis: null, treatmentDone: null };

  it("يرفض زيارة فارغة — مريضٌ جلس وقام ليست زيارة سريرية", () => {
    const result = canSign(base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("إجراءً أو تشخيصًا");
  });

  it("يقبل زيارة بتشخيص بلا إجراء — كشفٌ لا عمل فيه", () => {
    expect(canSign({ ...base, diagnosis: "التهاب لثة" }).ok).toBe(true);
  });

  it("يقبل زيارة بإجراء بلا تشخيص مكتوب", () => {
    expect(canSign({ ...base, procedures: [{ quantity: 1, unitPriceMinor: 20000 }] }).ok).toBe(true);
  });

  it("يرفض توقيع الموقَّعة — التصحيح بملحق لا بتوقيع ثانٍ", () => {
    const result = canSign({ ...base, status: "signed", diagnosis: "شيء" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ملحق");
  });
});

describe("الملحق", () => {
  it("يحمل كاتبه ووقته — من يعدّل بصمت يمكن أن يعدّل بعد شكوى", () => {
    const text = formatAddendum({
      text: "  صُحّح رقم السن إلى 26  ",
      author: "د. عقلان", at: "2026-08-28T14:30:00.000Z",
    });
    expect(text).toBe("— ملحق (د. عقلان · 2026-08-28 14:30): صُحّح رقم السن إلى 26");
  });
});
