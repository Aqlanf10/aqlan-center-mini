import { describe, expect, it } from "vitest";
import { expectedArrivals, lateText, LATE_MINUTES } from "../lib/arrivals";
import type { Appointment } from "../lib/schedule";

const appointment = (over: Partial<Appointment>): Appointment => ({
  id: 1, patientId: 1, patientName: "مريض", patientPhone: null,
  scheduledDate: "2026-09-12", scheduledTime: "10:00", durationMinutes: 30,
  appointmentType: null, note: null, status: "booked", reminderSentAt: null,
  doctorId: null, doctorName: null,
  ...over,
});

describe("مُنتظَرو اليوم", () => {
  it("المحجوز وحده يُنتظَر — والواصل والملغى والمتغيّب والمنتهي خرجوا", () => {
    const rows = expectedArrivals([
      appointment({ id: 1, status: "booked" }),
      appointment({ id: 2, status: "arrived" }),
      appointment({ id: 3, status: "cancelled" }),
      appointment({ id: 4, status: "no_show" }),
      appointment({ id: 5, status: "done" }),
    ], "09:00");

    expect(rows.map((row) => row.id)).toEqual([1]);
  });

  it("التأخير فرقُ الساعة عن الموعد، ومن لم يحن موعده ليس متأخّرًا بالسالب", () => {
    const rows = expectedArrivals([
      appointment({ id: 1, scheduledTime: "09:30" }),
      appointment({ id: 2, scheduledTime: "11:00" }),
    ], "10:00");

    expect(rows.find((row) => row.id === 1)?.lateMinutes).toBe(30);
    expect(rows.find((row) => row.id === 2)?.lateMinutes).toBe(0);
  });

  it("حدّ التأخّر ربع ساعة — والدقيقة التي قبله ليست تأخّرًا", () => {
    const [justBefore] = expectedArrivals([appointment({ scheduledTime: "10:00" })], "10:14");
    const [atLimit] = expectedArrivals([appointment({ scheduledTime: "10:00" })], "10:15");

    expect(justBefore.lateMinutes).toBe(LATE_MINUTES - 1);
    expect(justBefore.late).toBe(false);
    expect(atLimit.late).toBe(true);
  });

  it("الترتيب بالموعد لا بترتيب ورودها من القاعدة", () => {
    const rows = expectedArrivals([
      appointment({ id: 1, scheduledTime: "12:30" }),
      appointment({ id: 2, scheduledTime: "09:15" }),
      appointment({ id: 3, scheduledTime: "10:45" }),
    ], "09:00");

    expect(rows.map((row) => row.scheduledTime)).toEqual(["09:15", "10:45", "12:30"]);
  });

  it("وقتٌ غير مفهوم لا يُختلق له تأخير", () => {
    const [row] = expectedArrivals([appointment({ scheduledTime: "لا وقت" })], "10:00");
    expect(row.lateMinutes).toBe(0);
    expect(row.late).toBe(false);
  });

  it("نصّ التأخير عربيٌّ سليم — لا «1 دقيقة» ولا «2 دقائق»", () => {
    expect(lateText(0)).toBe("");
    expect(lateText(1)).toBe("متأخّر دقيقة");
    expect(lateText(2)).toBe("متأخّر دقيقتين");
    expect(lateText(5)).toBe("متأخّر 5 دقائق");
    expect(lateText(25)).toBe("متأخّر 25 دقيقة");
    expect(lateText(60)).toBe("متأخّر ساعة");
    expect(lateText(120)).toBe("متأخّر ساعتين");
    expect(lateText(95)).toBe("متأخّر ساعة و35 دقيقة");
  });
});
