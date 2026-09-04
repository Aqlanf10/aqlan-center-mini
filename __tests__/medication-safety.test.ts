import { describe, it, expect } from "vitest";
import { evaluatePrescriptionSafety } from "../lib/medication-safety";

describe("محرك الأمان والتعارضات الدوائية (Medication Safety Engine)", () => {
  it("يرصد فوراً حساسية البنسلين عند وصف أموكسيسيلين أو أوغمنتين", () => {
    const alertText = "المريض يعاني من حساسية بنسلين شديدة";
    const medications = [
      { name: "Amoxicillin 500mg" },
      { name: "Paracetamol 1g" },
    ];

    const alerts = evaluatePrescriptionSafety(medications, alertText);
    expect(alerts.length).toBe(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].title).toContain("Penicillin Allergy");
    expect(alerts[0].suggestedAlternative).toContain("Clindamycin");
  });

  it("يحذر من مسكنات NSAIDs أثناء الحمل", () => {
    const alertText = "حامل في الشهر الخامس";
    const medications = [
      { name: "Ibuprofen (Brufen) 400mg" },
    ];

    const alerts = evaluatePrescriptionSafety(medications, alertText);
    expect(alerts.length).toBe(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].suggestedAlternative).toContain("Paracetamol");
  });

  it("يحذر من مسكنات NSAIDs لمرضى سيولة الدم والأسبرين", () => {
    const alertText = "مريض يتناول أسبرين ومميعات دم";
    const medications = [
      { name: "Cataflam 50mg" },
    ];

    const alerts = evaluatePrescriptionSafety(medications, alertText);
    expect(alerts.length).toBe(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].title).toContain("Bleeding Risk");
  });

  it("لا يصدر تحذيرات عندما تكون الأدوية آمنة ومتوافقة تماماً", () => {
    const alertText = "حساسية بنسلين";
    const medications = [
      { name: "Clindamycin 300mg" },
      { name: "Paracetamol 500mg" },
    ];

    const alerts = evaluatePrescriptionSafety(medications, alertText);
    expect(alerts.length).toBe(0);
  });

  it("يتعامل بنجاح مع عدم وجود أدوية أو عدم وجود تنبيهات طبية", () => {
    expect(evaluatePrescriptionSafety([], "حساسية بنسلين")).toEqual([]);
    expect(evaluatePrescriptionSafety([{ name: "Amoxicillin" }], null)).toEqual([]);
    expect(evaluatePrescriptionSafety([{ name: "Amoxicillin" }], "")).toEqual([]);
  });
});
