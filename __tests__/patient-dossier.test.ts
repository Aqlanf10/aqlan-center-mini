import { describe, it, expect } from "vitest";
import {
  toothName,
  toUniversal,
  CONDITION_LABEL,
  STAGE_LABEL,
  buildChart,
  chartSummary,
  type ToothRecord,
} from "../lib/dental";
import {
  parseMedicalAlerts,
  getBloodPressureRisk,
  ageFromBirthYear,
  ageText,
  GENDER_LABEL,
} from "../lib/patient";

describe("الملف الطبي السريري الشامل (Patient Medical Dossier)", () => {
  describe("البيانات التعريفية والديموغرافية", () => {
    it("يحسب العمر بصيغ عربية صحيحة للملف الطبي", () => {
      const today = "2026-09-04";
      expect(ageText(ageFromBirthYear(1990, today))).toBe("36 سنة");
      expect(ageText(ageFromBirthYear(2025, today))).toBe("سنة واحدة");
      expect(ageText(ageFromBirthYear(2024, today))).toBe("سنتان");
      expect(ageText(ageFromBirthYear(2018, today))).toBe("8 سنوات");
      expect(ageText(ageFromBirthYear(null, today))).toBe("العمر غير مسجّل");
    });

    it("يوفر مسميات الجنس بالعربية", () => {
      expect(GENDER_LABEL.male).toBe("ذكر");
      expect(GENDER_LABEL.female).toBe("أنثى");
    });
  });

  describe("المؤشرات الحيوية والمخاطر السريرية في الملف الطبي", () => {
    it("يستخرج ضغط الدم ويفسره سريريًا للملف والتقرير المطبوع", () => {
      const raw = "[VITALS: BP=135/88, HR=76, BS=110, BG=O+, DATE=2026-09-04] حساسية بنسلين";
      const { vitals, badges, customNote } = parseMedicalAlerts(raw);

      expect(vitals).not.toBeNull();
      expect(vitals?.bpSystolic).toBe(135);
      expect(vitals?.bloodGroup).toBe("O+");

      const risk = getBloodPressureRisk(vitals?.bpSystolic, vitals?.bpDiastolic);
      expect(risk.category).toBe("stage1");
      expect(risk.severity).toBe("medium");

      expect(badges.some((b) => b.id === "allergy_penicillin")).toBe(true);
      expect(customNote).toBe("حساسية بنسلين");
    });

    it("يتعامل بدقة مع حالة غياب العلامات الحيوية", () => {
      const { vitals } = parseMedicalAlerts("لا توجد سوابق مرضية");
      expect(vitals).toBeNull();
      const risk = getBloodPressureRisk(vitals?.bpSystolic, vitals?.bpDiastolic);
      expect(risk.category).toBe("unknown");
      expect(risk.label).toBe("غير مسجّل");
    });
  });

  describe("تشريح ومخطط الأسنان في التقرير الطبي الشامل", () => {
    it("يحول أرقام الأسنان بين FDI و Universal (1-32) بدقة", () => {
      // 18 = الرحى الثالثة العلوية اليمنى (Universal 1)
      expect(toUniversal(18)).toBe("1");
      // 16 = الرحى الأولى العلوية اليمنى (Universal 3)
      expect(toUniversal(16)).toBe("3");
      // 11 = الثنية العلوية اليمنى (Universal 8)
      expect(toUniversal(11)).toBe("8");
      // 21 = الثنية العلوية اليسرى (Universal 9)
      expect(toUniversal(21)).toBe("9");
      // 48 = الرحى الثالثة السفلية اليمنى (Universal 32)
      expect(toUniversal(48)).toBe("32");
      // 36 = الرحى الأولى السفلية اليسرى (Universal 19)
      expect(toUniversal(36)).toBe("19");
    });

    it("يُخرج الأسماء التشريحية الصحيحة للأسنان", () => {
      expect(toothName(16)).toBe("الرحى الأولى العلوي الأيمن");
      expect(toothName(21)).toBe("القاطع الأوسط العلوي الأيسر");
      expect(toothName(33)).toBe("الناب السفلي الأيسر");
      expect(toothName(54)).toBe("الرحى الأولى العلوي الأيمن (لبني)");
    });

    it("يحلل ويبني ملخص حالات المخطط السني للتقرير الطبي", () => {
      const records: ToothRecord[] = [
        {
          id: 1,
          toothCode: 16,
          condition: "caries",
          stage: "existing",
          surfaces: "MOD",
          note: "نخر عميق",
          recordedBy: "د. أحمد",
          recordedAt: "2026-08-01T10:00:00Z",
          visitId: 10,
        },
        {
          id: 2,
          toothCode: 24,
          condition: "crown",
          stage: "planned",
          surfaces: null,
          note: "تاج زركونيا",
          recordedBy: "د. أحمد",
          recordedAt: "2026-08-02T10:00:00Z",
          visitId: 10,
        },
        {
          id: 3,
          toothCode: 36,
          condition: "extracted",
          stage: "existing",
          surfaces: null,
          note: "مخلوع سابقًا",
          recordedBy: "د. أحمد",
          recordedAt: "2026-08-03T10:00:00Z",
          visitId: 10,
        },
      ];

      const chart = buildChart(records);
      const summary = chartSummary(chart);

      expect(summary.charted).toBe(3);
      expect(summary.caries).toBe(1);
      expect(summary.planned).toBe(1);
      expect(summary.absent).toBe(1);

      expect(CONDITION_LABEL.caries).toBe("تسوّس");
      expect(STAGE_LABEL.planned).toBe("مخطَّط");
      expect(STAGE_LABEL.completed).toBe("منجَز");
    });
  });
});
