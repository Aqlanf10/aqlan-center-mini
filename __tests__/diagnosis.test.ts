import { describe, expect, it } from "vitest";
import {
  diagnosisSummary, validateDiagnosisContent, type DiagnosisContent,
} from "../lib/diagnosis";

describe("التشخيص النسخي", () => {
  it("نسخةٌ فارغة كلّها تُرفض — لا تُحفَظ أوراقٌ بيضاء في سجلٍ يُضاف إليه فقط", () => {
    expect(validateDiagnosisContent({}).ok).toBe(false);
    expect(validateDiagnosisContent(null).ok).toBe(false);
    expect(validateDiagnosisContent({
      skeletal: "  ", dental: "", crowding: null, overjet: "", bite: "   ", note: "",
    }).ok).toBe(false);
  });

  it("حقلٌ واحدٌ متغيّر كافٍ لنسخةٍ جديدة، والفراغات تُقصّ", () => {
    const check = validateDiagnosisContent({ overjet: "  5 مم  " });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.content.overjet).toBe("5 مم");
      expect(check.content.skeletal).toBeNull();
    }
  });

  it("النصّ الطويل يُقصّ على الحدّ — الحماية من المقالات في حقول التشخيص", () => {
    const check = validateDiagnosisContent({ note: "ك".repeat(2000) });
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.content.note?.length).toBeLessThanOrEqual(1000);
  });

  it("الملخّص يعرض الحقول المملوءة وحدها وبعناوينها العربية", () => {
    const content: DiagnosisContent = {
      skeletal: "Class II هيكلي",
      dental: "Class II Div 1",
      crowding: null,
      overjet: "7 مم",
      bite: "عمق إطباق",
      note: "ملاحظة حرة",
    };
    const lines = diagnosisSummary(content);
    expect(lines).toContain("الصنف الهيكلي: Class II هيكلي");
    expect(lines).toContain("الصنف السني: Class II Div 1");
    expect(lines).toContain("البعد الأفقي Overjet: 7 مم");
    expect(lines).toContain("ملاحظة حرة");
    expect(lines.some((line) => line.includes("الازدحام"))).toBe(false);
  });
});
