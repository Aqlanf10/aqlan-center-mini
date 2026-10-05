import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLINIC, reminderText, unbookedFollowupText, whatsAppDirectLink,
} from "../lib/reminders";
import type { Appointment } from "../lib/schedule";

describe("unbooked follow-up invitation", () => {
  it("invites the patient to choose a time without inventing a booking", () => {
    const text = unbookedFollowupText("مريض تجريبي");
    expect(text).toBe([
      "السلام عليكم مريض تجريبي،",
      "",
      `نودّ ترتيب موعد متابعة لكم في ${DEFAULT_CLINIC.name}.`,
      "يرجى التواصل معنا لاختيار موعد يناسبكم.",
      "",
      `للتواصل: ${DEFAULT_CLINIC.phone}`,
    ].join("\n"));
    for (const claim of ["نذكّركم بموعدكم", "الساعة", "16:00", "4:00", "مكانكم محفوظ", "لنؤجله", "تم بنجاح تأكيد"]) {
      expect(text).not.toContain(claim);
    }
  });

  it("uses the provided clinic identity and safely encodes the invitation", () => {
    const text = unbookedFollowupText("اسم & تجريبي", { name: "عيادة تجريبية", phone: "000-test" });
    expect(text).toContain("عيادة تجريبية");
    expect(text).toContain("للتواصل: 000-test");
    expect(text).not.toContain(DEFAULT_CLINIC.name);
    const link = whatsAppDirectLink("770123456", text);
    expect(link).not.toBeNull();
    expect(new URL(link!).searchParams.get("text")).toBe(text);
  });

  it("leaves an actual booked appointment's reminder text unchanged", () => {
    const appointment: Appointment = {
      id: 31, patientId: 19, patientName: "مريض تجريبي", patientPhone: "770123456",
      scheduledDate: "2026-10-08", scheduledTime: "10:30", durationMinutes: 15,
      note: null, status: "booked",
    };
    expect(reminderText(appointment, "upcoming")).toBe([
      "السلام عليكم مريض تجريبي،",
      "",
      `نذكّركم بموعدكم في ${DEFAULT_CLINIC.name}:`,
      "الخميس 08/10 الساعة 10:30 صباحًا",
      "",
      "إن كان الموعد لا يناسبكم، أخبرونا لنؤجله — مكانكم محفوظ.",
      `للتواصل: ${DEFAULT_CLINIC.phone}`,
    ].join("\n"));
  });
});
