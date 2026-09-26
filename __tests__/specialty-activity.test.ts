import { describe, expect, it } from "vitest";
import { activityBySpecialty, labCostBySpecialty, labOrderCategory, materialCost } from "../lib/specialty-activity";

/** (RPT-SPEC) قواعد النشاط والتكلفة في التقرير حسب التخصص. */

describe("labOrderCategory — no guessing without evidence", () => {
  it("prefers the visit's single specialty, then the work type, then the lab service category", () => {
    expect(labOrderCategory({ visitCategory: "rct", workType: "تاج زيركون", labCategory: "prostho" })).toBe("rct");
    expect(labOrderCategory({ visitCategory: null, workType: "جسر زيركون", labCategory: "prostho" })).toBe("bridge");
    expect(labOrderCategory({ visitCategory: null, workType: "عدسة فينير", labCategory: "prostho" })).toBe("veneer");
    expect(labOrderCategory({ visitCategory: null, workType: "جهاز تقويم متحرك", labCategory: "appliance" })).toBe("ortho");
    expect(labOrderCategory({ visitCategory: null, workType: "حافظ مسافة", labCategory: null })).toBe("ortho");
    expect(labOrderCategory({ visitCategory: null, workType: "طقم أسنان كامل", labCategory: "prostho" })).toBeNull();
    expect(labOrderCategory({ visitCategory: null, workType: "واقي أسنان ليلي", labCategory: "appliance" })).toBeNull();
  });
});

describe("activity and costs", () => {
  const procedures = [
    { date: "2025-09-10", visitId: 1, patientId: 10, doctorId: 7, category: "rct", quantity: 1 },
    { date: "2025-09-10", visitId: 1, patientId: 10, doctorId: 7, category: "rct", quantity: 2 },
    { date: "2025-09-11", visitId: 2, patientId: 11, doctorId: 8, category: "ortho", quantity: 1 },
    { date: "2025-08-30", visitId: 3, patientId: 12, doctorId: 7, category: "rct", quantity: 1 },
  ];

  it("counts procedures by quantity, distinct visits, patients and doctors inside the period", () => {
    const activity = activityBySpecialty(procedures, "2025-09-01", "2025-09-30");
    expect(activity.get("rct")).toEqual({ procedures: 3, visits: 1, patients: 1, doctors: 1 });
    expect(activity.get("ortho")).toEqual({ procedures: 1, visits: 1, patients: 1, doctors: 1 });
    expect(activityBySpecialty(procedures, "2025-09-01", "2025-09-30", 8).has("rct")).toBe(false);
  });

  it("lab cost stays in its own currency; material cost is the specialty rate of its collections", () => {
    const lab = labCostBySpecialty([
      { date: "2025-09-10", doctorId: 7, labCategory: "prostho", workType: "تاج", visitCategory: null, costMinor: 5000, currency: "SAR" },
      { date: "2025-09-12", doctorId: 7, labCategory: "prostho", workType: "تاج", visitCategory: null, costMinor: 20000, currency: "YER" },
    ], "2025-09-01", "2025-09-30");
    expect(lab.get("crown")).toEqual({ YER: 20000, SAR: 5000, USD: 0 });
    expect(materialCost({ YER: 49000, SAR: 1000, USD: 0 }, 1000)).toEqual({ YER: 4900, SAR: 100, USD: 0 });
    expect(materialCost({ YER: 49000, SAR: 0, USD: 0 }, undefined)).toEqual({ YER: 0, SAR: 0, USD: 0 });
  });
});
