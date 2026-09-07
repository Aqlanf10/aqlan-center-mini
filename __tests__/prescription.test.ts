import { describe, expect, it } from "vitest";
import {
  buildSuggestions, checkPrescriptionDraft, checkVoidReason, sanitizeRxItem, sanitizeRxItems,
} from "../lib/prescription";

describe("تنقية الوصفة — لا تُختلق وصفة", () => {
  it("الدواء بلا اسم لاتينيّ سطرٌ فارغ لا دواء ناقص", () => {
    expect(sanitizeRxItem({ name: "", dose: "500mg" })).toBeNull();
    expect(sanitizeRxItem({ name: "أموكسيسيلين" })).toBeNull();
    expect(sanitizeRxItem({ name: "Amoxicillin 500" })).toMatchObject({ name: "Amoxicillin 500" });
  });

  it("الحدود تمنع حقلاً من ابتلاع الوثيقة", () => {
    const item = sanitizeRxItem({ name: "Ibuprofen".repeat(100) });
    expect(item?.name.length).toBeLessThanOrEqual(200);
  });

  it("بنودٌ من مدخل غير موثوق: الصالح يبقى والفارغ يسقط", () => {
    const items = sanitizeRxItems([{ name: "Augmentin" }, { name: "" }, "نص", null]);
    expect(items).toHaveLength(1);
  });
});

describe("فحص المسوّدة — البطلان بأسبابٍ مصرّحة", () => {
  it("الوصفة بلا أدوية تُردّ بلا غموض", () => {
    const check = checkPrescriptionDraft({
      patientId: 1, visitId: null, diagnosis: "", notes: "",
      instructionsLang: "both", items: [],
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain("أدوية");
  });

  it("المسوّدة السليمة تعود كاملةً بلغةٍ صالحة أو الافتراضية", () => {
    const check = checkPrescriptionDraft({
      patientId: 1, visitId: null, diagnosis: "خراج", notes: "",
      instructionsLang: "weird", items: [{ name: "Amoxicillin", dose: "500mg" }],
    });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.value.instructionsLang).toBe("both");
      expect(check.value.items[0].name).toBe("Amoxicillin");
    }
  });

  it("رقم ملفٍ غير صالح يُردّ قبل أي شيء", () => {
    const check = checkPrescriptionDraft({
      patientId: 0, visitId: null, diagnosis: "", notes: "",
      instructionsLang: "both", items: [{ name: "A" }],
    });
    expect(check.ok).toBe(false);
  });
});

describe("سبب الإبطال — «خطأ» وحدها لا تُقرأ بعد سنة", () => {
  it("قصيرٌ يُرفض وطويلٌ يُقبل", () => {
    expect(checkVoidReason("خطأ").ok).toBe(false);
    expect(checkVoidReason("خطأ جرعة الدواء الثاني").ok).toBe(true);
    expect(checkVoidReason(null).ok).toBe(false);
  });
});

describe("الاقتراحات مما سبق وصفه — الأحدث أولًا ثم الأكثر تكرارًا", () => {
  const drug = (name: string) => ({
    name, dose: "500mg", form: "Tablets", frequency: "",
    duration: "5 days", instructions: "", instructionsEn: "",
  });

  it("تُبنى من الوصفات الفاعلة بعدد مراتها", () => {
    const suggestions = buildSuggestions([
      { items: [drug("Ibuprofen")], createdAt: "2026-01-01T00:00:00Z" },
      { items: [drug("Ibuprofen"), drug("Augmentin")], createdAt: "2026-06-01T00:00:00Z" },
    ]);
    expect(suggestions[0].name).toBe("Ibuprofen"); // الأحدث
    expect(suggestions.find((s) => s.name === "Ibuprofen")?.timesPrescribed).toBe(2);
    expect(suggestions.find((s) => s.name === "Augmentin")?.timesPrescribed).toBe(1);
  });

  it("قائمةٌ فارغة لا تقترح شيئًا", () => {
    expect(buildSuggestions([])).toEqual([]);
  });
});
