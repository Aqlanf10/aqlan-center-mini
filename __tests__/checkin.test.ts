import { describe, expect, it } from "vitest";
import {
  CHIEF_COMPLAINTS,
  CHECKIN_MEDICAL_QUESTIONS,
  validateCheckinInput,
  serializeCheckinAlerts,
  buildCheckinVisitNote,
  calculateQueueEstimate,
} from "../lib/checkin";

describe("lib/checkin (Self-Checkin & Medical Intake Kiosk)", () => {
  it("defines standard dental chief complaints with urgency flags", () => {
    expect(CHIEF_COMPLAINTS.length).toBeGreaterThanOrEqual(8);
    const emergency = CHIEF_COMPLAINTS.find((c) => c.id === "emergency_pain");
    expect(emergency).toBeDefined();
    expect(emergency?.isUrgent).toBe(true);

    const checkup = CHIEF_COMPLAINTS.find((c) => c.id === "routine_checkup");
    expect(checkup?.isUrgent).toBe(false);
  });

  it("validates input strictly and rejects invalid phone or empty names", () => {
    const invalidPhone = validateCheckinInput({
      phone: "123",
      fullName: "أحمد علي",
      complaintId: "routine_checkup",
    });
    expect(invalidPhone.ok).toBe(false);

    const invalidName = validateCheckinInput({
      phone: "770123456",
      fullName: "أ",
      complaintId: "routine_checkup",
    });
    expect(invalidName.ok).toBe(false);

    const invalidComplaint = validateCheckinInput({
      phone: "770123456",
      fullName: "أحمد علي سالم",
      complaintId: "invalid_reason",
    });
    expect(invalidComplaint.ok).toBe(false);

    const valid = validateCheckinInput({
      phone: "+967 770 123 456",
      fullName: "أحمد علي سالم",
      complaintId: "emergency_pain",
      conditions: ["diabetes", "penicillin_allergy"],
      allergies: "حساسية أسبرين وبنسلين",
      age: 32,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.phone).toBe("+967 770 123 456");
      expect(valid.value.conditions).toContain("diabetes");
      expect(valid.value.conditions).toContain("penicillin_allergy");
      expect(valid.value.birthYear).toBe(new Date().getFullYear() - 32);
    }
  });

  it("serializes checkin medical alerts properly", () => {
    const input = {
      phone: "770123456",
      fullName: "مريض تجريبي",
      complaintId: "routine_checkup" as const,
      conditions: ["diabetes", "bleeding"],
      allergies: "بنسلين",
      medications: "ميتفورمين 500",
      habits: { smoking: true, khat: false },
    };

    const alertText = serializeCheckinAlerts(input);
    expect(alertText).toContain("سكري");
    expect(alertText).toContain("سيولة دم / مميعات");
    expect(alertText).toContain("حساسية: بنسلين");
    expect(alertText).toContain("أدوية: ميتفورمين 500");
    expect(alertText).toContain("مدخن");
  });

  it("builds clear chairside visit notes with emergency alerts", () => {
    const emergencyInput = {
      phone: "770123456",
      fullName: "مريض طوارئ",
      complaintId: "emergency_pain" as const,
      complaintNote: "ألم نابض لا يحتمل في الضرس الخلفي السفلي",
      conditions: ["hypertension"],
      allergies: "أوجمنتين",
    };

    const note = buildCheckinVisitNote(emergencyInput);
    expect(note).toContain("🚨 [طوارئ وألم حاد]");
    expect(note).toContain("الشكوى: ألم أسنان حاد / طوارئ");
    expect(note).toContain("ألم نابض");
    expect(note).toContain("ضغط مرتفع");
    expect(note).toContain("أوجمنتين");
  });

  it("calculates queue wait time estimates gracefully", () => {
    const zero = calculateQueueEstimate(0, 15);
    expect(zero.positionText).toContain("التالي للدخول");
    expect(zero.estimatedWaitMinutes).toBe(0);

    const one = calculateQueueEstimate(1, 20);
    expect(one.positionText).toContain("أمامك مريض واحد فقط");
    expect(one.estimatedWaitMinutes).toBe(20);

    const three = calculateQueueEstimate(3, 10);
    expect(three.positionText).toContain("أمامك 3 مرضى");
    expect(three.estimatedWaitMinutes).toBe(30);
  });
});
