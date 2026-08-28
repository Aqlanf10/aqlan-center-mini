import { describe, expect, it } from "vitest";
import { appointmentsCountText, dayReport, minutesText, reportText, shortMinutes, tomorrowLoad } from "../lib/report";
import type { Visit } from "../lib/flow";
import type { Appointment } from "../lib/schedule";

const NOW = new Date("2026-08-27T12:00:00.000Z");

function visit(over: Partial<Visit> & { id: number }): Visit {
  return {
    patientId: null,
    patientName: `مريض ${over.id}`,
    patientPhone: null,
    note: null,
    status: "waiting",
    chair: null,
    arrivedAt: "2026-08-27T11:00:00.000Z",
    seatedAt: null,
    calledAt: null,
    finishedAt: null,
    ...over,
  };
}

function appt(over: Partial<Appointment> & { id: number }): Appointment {
  return {
    patientId: over.id,
    patientName: `مريض ${over.id}`,
    patientPhone: null,
    scheduledDate: "2026-08-27",
    scheduledTime: "10:00",
    durationMinutes: 30,
    note: null,
    status: "booked",
    ...over,
  };
}

describe("تقرير اليوم", () => {
  it("ينهي الانتظار عند النداء لا عند الجلوس", () => {
    // من نُودي عليه انتهى انتظاره وإن مشى دقيقة إلى الكرسي.
    const report = dayReport([
      visit({ id: 1, status: "in_chair", calledAt: "2026-08-27T11:20:00.000Z", seatedAt: "2026-08-27T11:25:00.000Z" }),
    ], [], NOW);
    expect(report.averageWaitMinutes).toBe(20);
  });

  it("يَعُدّ من ما زال ينتظر الآن — لا يستبعده", () => {
    // استبعاد المنتظر يجعل المتوسط جميلًا في أسوأ الأيام.
    const report = dayReport([
      visit({ id: 1, status: "done", calledAt: "2026-08-27T11:10:00.000Z", finishedAt: "2026-08-27T11:40:00.000Z" }),
      visit({ id: 2 }), // وصل 11:00 وما زال ينتظر عند 12:00
    ], [], NOW);
    expect(report.longestWaitMinutes).toBe(60);
    expect(report.averageWaitMinutes).toBe(35);
  });

  it("يحسب وقت الكرسي لمن جلس وانتهى فقط", () => {
    const report = dayReport([
      visit({ id: 1, status: "done", seatedAt: "2026-08-27T11:10:00.000Z", finishedAt: "2026-08-27T11:55:00.000Z" }),
      visit({ id: 2, status: "in_chair", seatedAt: "2026-08-27T11:50:00.000Z" }), // لم ينتهِ بعد
    ], [], NOW);
    expect(report.averageChairMinutes).toBe(45);
  });

  it("يجمع أرقام الحضور والمواعيد", () => {
    const report = dayReport(
      [visit({ id: 1, status: "done" }), visit({ id: 2, status: "in_chair" })],
      [
        appt({ id: 1, status: "done" }),
        appt({ id: 2, status: "no_show" }),
        appt({ id: 3, status: "cancelled" }),
        appt({ id: 4, status: "booked" }),
      ],
      NOW,
    );
    expect(report.arrived).toBe(2);
    expect(report.done).toBe(1);
    expect(report.stillOpen).toBe(1);
    expect(report.noShow).toBe(1);
    expect(report.cancelled).toBe(1);
    // المحجوز الذي لم يصل ولم يُعلَّم متغيّبًا هو العمل غير المُنهى في السجل.
    expect(report.unresolved).toBe(1);
  });

  it("يعطي أصفارًا ليوم بلا حركة بدل أن ينهار", () => {
    const report = dayReport([], [], NOW);
    expect(report.averageWaitMinutes).toBe(0);
    expect(report.longestWaitMinutes).toBe(0);
    expect(report.averageChairMinutes).toBe(0);
  });
});

describe("حِمل الغد", () => {
  it("يتجاهل الملغى ومن لم يحضر — لا يشغلان كرسيًا", () => {
    const tomorrow = "2026-08-28";
    const load = tomorrowLoad([
      appt({ id: 1, scheduledDate: tomorrow, durationMinutes: 60 }),
      appt({ id: 2, scheduledDate: tomorrow, durationMinutes: 60, status: "cancelled" }),
    ], tomorrow, 2);
    expect(load.booked).toBe(1);
    expect(load.bookedMinutes).toBe(60);
  });
});

describe("نص الملخص", () => {
  it("يُكتب ليُرسَل في واتساب لا ليُقرأ في جدول", () => {
    const text = reportText({
      clinicName: "مركز الدكتور عقلان الكامل",
      dateText: "الخميس 27/08/2026",
      report: dayReport([visit({ id: 1, status: "done", calledAt: "2026-08-27T11:30:00.000Z" })], [], NOW),
      tomorrowPercent: 90,
      lateLabOrders: 2,
    });
    expect(text).toContain("الخميس 27/08/2026");
    expect(text).toContain("الحضور: 1");
    expect(text).toContain("حِمل الغد: 90٪");
    expect(text).toContain("تراكيب متأخرة: 2");
  });
});

describe("عدّ المواعيد بالعربية", () => {
  it("يستعمل الصيغ الأربع — «3 موعدًا» تُقرأ كإهمال", () => {
    expect(appointmentsCountText(0)).toBe("لا مواعيد");
    expect(appointmentsCountText(1)).toBe("موعد واحد");
    expect(appointmentsCountText(2)).toBe("موعدان");
    expect(appointmentsCountText(3)).toBe("3 مواعيد");
    expect(appointmentsCountText(10)).toBe("10 مواعيد");
    expect(appointmentsCountText(11)).toBe("11 موعدًا");
  });
});

describe("صياغة الدقائق بالعربية", () => {
  it("يعدّ كما تعدّ العربية لا كما تعدّ الإنجليزية", () => {
    expect(minutesText(0)).toBe("لا انتظار");
    expect(minutesText(1)).toBe("دقيقة");
    expect(minutesText(2)).toBe("دقيقتان");
    expect(minutesText(5)).toBe("5 دقائق");
    expect(minutesText(25)).toBe("25 دقيقة");
  });

  it("يتحوّل إلى ساعات حين تطول المدة", () => {
    expect(minutesText(60)).toBe("ساعة");
    expect(minutesText(120)).toBe("ساعتان");
    expect(minutesText(95)).toBe("ساعة و35 د");
  });

  it("المختصر يبقى رقمًا يصلح لبطاقة ضيّقة", () => {
    expect(shortMinutes(0)).toBe("0 دقيقة");
    expect(shortMinutes(95)).toBe("1:35 ساعة");
  });
});
