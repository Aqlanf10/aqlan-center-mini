import { describe, it, expect } from "vitest";
import {
  getBloodPressureRisk,
  parsePatientVitals,
  serializeVitalsToAlert,
  parseMedicalAlerts,
  BLOOD_GROUPS,
  type VitalSigns,
} from "../lib/patient";

describe("علامات المريض الحيوية وفئات ضغط الدم (Vital Signs)", () => {
  describe("تصنيف مخاطر ضغط الدم getBloodPressureRisk", () => {
    it("يصنف الضغط الطبيعي والمثالي", () => {
      const risk = getBloodPressureRisk(118, 76);
      expect(risk.category).toBe("normal");
      expect(risk.severity).toBe("low");
      expect(risk.color).toBe("emerald");
      expect(risk.clinicalNote).toContain("طبيعية");
    });

    it("يصنف الضغط المرتفع الطفيف Elevated", () => {
      const risk = getBloodPressureRisk(125, 78);
      expect(risk.category).toBe("elevated");
      expect(risk.severity).toBe("low");
      expect(risk.color).toBe("yellow");
    });

    it("يصنف ضغط المرحلة الأولى Stage 1", () => {
      const riskSystolic = getBloodPressureRisk(132, 75);
      expect(riskSystolic.category).toBe("stage1");
      expect(riskSystolic.severity).toBe("medium");
      expect(riskSystolic.color).toBe("amber");

      const riskDiastolic = getBloodPressureRisk(115, 84);
      expect(riskDiastolic.category).toBe("stage1");
    });

    it("يصنف ضغط المرحلة الثانية Stage 2", () => {
      const risk = getBloodPressureRisk(145, 95);
      expect(risk.category).toBe("stage2");
      expect(risk.severity).toBe("high");
      expect(risk.color).toBe("rose");
      expect(risk.clinicalNote).toContain("تقليل جرعات الأدرينالين");
    });

    it("يصنف أزمة فرط ضغط الدم الحادة Hypertensive Crisis", () => {
      const riskSys = getBloodPressureRisk(185, 90);
      expect(riskSys.category).toBe("crisis");
      expect(riskSys.severity).toBe("critical");
      expect(riskSys.clinicalNote).toContain("طوارئ طبية");

      const riskDia = getBloodPressureRisk(130, 125);
      expect(riskDia.category).toBe("crisis");
      expect(riskDia.severity).toBe("critical");
    });

    it("يتعامل مع القيم غير المسجلة أو السالبة", () => {
      expect(getBloodPressureRisk(null, null).category).toBe("unknown");
      expect(getBloodPressureRisk(0, 0).category).toBe("unknown");
      expect(getBloodPressureRisk(-120, -80).category).toBe("unknown");
    });
  });

  describe("استخراج وحفظ العلامات الحيوية المنظمة parsePatientVitals & serializeVitalsToAlert", () => {
    it("يستخرج العلامات الحيوية المنظمة بالوسم القياسي", () => {
      const rawAlert = "[VITALS: BP=135/85, HR=78, BS=120, BG=O+, DATE=2026-09-04] حساسية بنسلين شديدة";
      const { vitals, cleanAlert } = parsePatientVitals(rawAlert);

      expect(vitals).not.toBeNull();
      expect(vitals?.bpSystolic).toBe(135);
      expect(vitals?.bpDiastolic).toBe(85);
      expect(vitals?.pulse).toBe(78);
      expect(vitals?.bloodSugar).toBe(120);
      expect(vitals?.bloodGroup).toBe("O+");
      expect(vitals?.recordedAt).toBe("2026-09-04");
      expect(cleanAlert).toBe("حساسية بنسلين شديدة");
    });

    it("يستخرج من الصيغة العربية للوسم", () => {
      const rawAlert = "[علامات حيوية: ضغط=120/80 نبض=72 سكر=95 فصيلة=A+ تاريخ=2026-09-01] مريض قلب";
      const { vitals, cleanAlert } = parsePatientVitals(rawAlert);

      expect(vitals?.bpSystolic).toBe(120);
      expect(vitals?.bpDiastolic).toBe(80);
      expect(vitals?.pulse).toBe(72);
      expect(vitals?.bloodSugar).toBe(95);
      expect(vitals?.bloodGroup).toBe("A+");
      expect(vitals?.recordedAt).toBe("2026-09-01");
      expect(cleanAlert).toBe("مريض قلب");
    });

    it("يستخرج بذكاء من النص الحر إذا لم يوجد وسم", () => {
      const rawAlert = "المريض يعاني من ضغط 140/90 ونبض 85 وفصيلة الدم B+";
      const { vitals } = parsePatientVitals(rawAlert);

      expect(vitals?.bpSystolic).toBe(140);
      expect(vitals?.bpDiastolic).toBe(90);
      expect(vitals?.pulse).toBe(85);
      expect(vitals?.bloodGroup).toBe("B+");
    });

    it("يحول الكائن إلى وسم قياسي ويدمجه مع الملاحظة الطبية", () => {
      const vitals: VitalSigns = {
        bpSystolic: 128,
        bpDiastolic: 82,
        pulse: 74,
        bloodSugar: 105,
        bloodGroup: "AB+",
        recordedAt: "2026-09-04",
      };
      const note = "حساسية مفرطة من الأسبرين";
      const serialized = serializeVitalsToAlert(vitals, note);

      expect(serialized).toContain("[VITALS: BP=128/82, HR=74, BS=105, BG=AB+, DATE=2026-09-04]");
      expect(serialized).toContain("حساسية مفرطة من الأسبرين");

      // إعادة الفك والتأكد من التوافقية العكسية
      const reParsed = parsePatientVitals(serialized);
      expect(reParsed.vitals?.bpSystolic).toBe(128);
      expect(reParsed.vitals?.bpDiastolic).toBe(82);
      expect(reParsed.cleanAlert).toBe("حساسية مفرطة من الأسبرين");
    });

    it("يحدّث الوسم القائم دون تكراره عند حفظ علامات جديدة", () => {
      const initialAlert = "[VITALS: BP=120/80, HR=70] حساسية سلفا";
      const newVitals: VitalSigns = {
        bpSystolic: 130,
        bpDiastolic: 85,
        pulse: 75,
      };

      const updated = serializeVitalsToAlert(newVitals, initialAlert);
      expect(updated).toBe("[VITALS: BP=130/85, HR=75] حساسية سلفا");
      expect(updated.match(/\[VITALS/g)?.length).toBe(1);
    });
  });

  describe("التكامل مع parseMedicalAlerts", () => {
    it("يُرجع الشارات والعلامات الحيوية والنص النظيف معًا", () => {
      const raw = "[VITALS: BP=150/95, BG=O+] مريض سكري ويتناول مميعات دم";
      const parsed = parseMedicalAlerts(raw);

      expect(parsed.vitals?.bpSystolic).toBe(150);
      expect(parsed.vitals?.bloodGroup).toBe("O+");
      expect(parsed.badges.some((b) => b.id === "diabetes")).toBe(true);
      expect(parsed.badges.some((b) => b.id === "bleeding_disorder")).toBe(true);
      expect(parsed.customNote).toBe("مريض سكري ويتناول مميعات دم");
    });
  });

  describe("قائمة فصائل الدم المعيارية", () => {
    it("تحتوي على جميع الفصائل الثمانية", () => {
      expect(BLOOD_GROUPS).toEqual(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]);
    });
  });
});
