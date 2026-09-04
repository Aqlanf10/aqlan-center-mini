import { describe, expect, it } from "vitest";
import { ageFromBirthYear, ageText, validatePatient, parseMedicalAlerts } from "../lib/patient";


const TODAY = "2026-08-27";

describe("العمر", () => {
  it("يُحسب من سنة الميلاد ويُنطق بصيغ العربية", () => {
    expect(ageFromBirthYear(1992, TODAY)).toBe(34);
    expect(ageText(ageFromBirthYear(1992, TODAY))).toBe("34 سنة");
    expect(ageText(ageFromBirthYear(2024, TODAY))).toBe("سنتان");
    expect(ageText(ageFromBirthYear(2020, TODAY))).toBe("6 سنوات");
    expect(ageText(null)).toBe("العمر غير مسجّل");
  });
});

describe("التحقق من بيانات المريض", () => {
  it("يقبل الحد الأدنى: اسم وحده", () => {
    const result = validatePatient({ fullName: "  عبدالله   محمد " }, TODAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fullName).toBe("عبدالله محمد");
    expect(result.value.gender).toBe("unknown");
    expect(result.value.phone).toBeNull();
  });

  it("يسمّي الحقل الخاطئ — النموذج فيه ثمانية حقول", () => {
    const noName = validatePatient({ fullName: "" }, TODAY);
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.field).toBe("fullName");

    const badYear = validatePatient({ fullName: "عبدالله", birthYear: "1092" }, TODAY);
    expect(badYear.ok).toBe(false);
    if (!badYear.ok) expect(badYear.field).toBe("birthYear");
  });

  it("يرفض سنة ميلاد في المستقبل", () => {
    expect(validatePatient({ fullName: "عبدالله", birthYear: "2030" }, TODAY).ok).toBe(false);
  });

  it("يقرأ الأرقام العربية الهندية في سنة الميلاد", () => {
    const result = validatePatient({ fullName: "عبدالله", birthYear: "١٩٩٢" }, TODAY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.birthYear).toBe(1992);
  });

  it("يرفض اسمًا بلا حروف", () => {
    expect(validatePatient({ fullName: "12345" }, TODAY).ok).toBe(false);
  });
});

describe("تحليل شارات التنبيه الطبي", () => {
  it("يستخرج الشارات المناسبة حسب الكلمات المفتاحية", () => {
    const result = parseMedicalAlerts("مريض سكري ويعاني من حساسية بنسلين شديدة");
    expect(result.badges.some((b) => b.id === "diabetes")).toBe(true);
    expect(result.badges.some((b) => b.id === "allergy_penicillin")).toBe(true);
    expect(result.customNote).toBe("مريض سكري ويعاني من حساسية بنسلين شديدة");
  });

  it("يتعامل مع النص الفارغ بنجاح", () => {
    expect(parseMedicalAlerts(null).badges).toHaveLength(0);
    expect(parseMedicalAlerts("").badges).toHaveLength(0);
  });
});

