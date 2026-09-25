import { describe, expect, it } from "vitest";
import { awaitsReminder } from "@/lib/reminders";

/** فلتر «لم يُذكَّر» — جولة المساء على قائمة الغد. */
describe("awaitsReminder", () => {
  const base = { status: "booked" as const, reminderSentAt: null, patientPhone: "777123456" };

  it("محجوزٌ لم يُذكَّر وله رقم ⇒ ينتظر تذكيره", () => {
    expect(awaitsReminder(base)).toBe(true);
  });

  it("ذُكِّر، أو لا رقم له، أو ليس محجوزًا ⇒ لا", () => {
    expect(awaitsReminder({ ...base, reminderSentAt: "2026-09-25T15:00:00Z" })).toBe(false);
    expect(awaitsReminder({ ...base, patientPhone: null })).toBe(false);
    expect(awaitsReminder({ ...base, patientPhone: "12" })).toBe(false);
    for (const status of ["arrived", "done", "cancelled", "no_show"] as const) {
      expect(awaitsReminder({ ...base, status })).toBe(false);
    }
  });
});
