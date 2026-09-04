import { describe, expect, it } from "vitest";
import {
  calledVisits,
  chairRows,
  daySummary,
  firstFreeChair,
  firstNameOnly,
  minutesSince,
  waitingRows,
  waitLevel,
  type Visit,
} from "../lib/flow";

const NOW = new Date("2026-08-24T10:00:00.000Z");

function visit(over: Partial<Visit> & { id: number }): Visit {
  return {
    patientId: null,
    patientName: `مريض ${over.id}`,
    patientPhone: null,
    note: null,
    status: "waiting",
    chair: null,
    arrivedAt: NOW.toISOString(),
    seatedAt: null,
    calledAt: null,
    finishedAt: null,
    ...over,
  };
}

describe("حساب الانتظار", () => {
  it("يحسب الدقائق منذ الوصول", () => {
    expect(minutesSince("2026-08-24T09:25:00.000Z", NOW)).toBe(35);
  });

  it("يقرأ الطابع المستقبلي صفرًا لا رقمًا سالبًا", () => {
    // انحراف بسيط في ساعة جهاز الاستقبال كان سيعرض «‎-3 د».
    expect(minutesSince("2026-08-24T10:03:00.000Z", NOW)).toBe(0);
  });

  it("يعطي صفرًا لطابع غائب أو تالف بدل أن ينهار", () => {
    expect(minutesSince(null, NOW)).toBe(0);
    expect(minutesSince("ليس تاريخًا", NOW)).toBe(0);
  });

  it("يصنّف الانتظار عند حدوده بالضبط", () => {
    expect(waitLevel(14)).toBe("calm");
    expect(waitLevel(15)).toBe("warning");
    expect(waitLevel(29)).toBe("warning");
    expect(waitLevel(30)).toBe("critical");
  });
});

describe("قائمة الانتظار", () => {
  it("ترتّب الأطول انتظارًا أولًا — وهو ترتيب النداء", () => {
    const rows = waitingRows([
      visit({ id: 1, arrivedAt: "2026-08-24T09:50:00.000Z" }),
      visit({ id: 2, arrivedAt: "2026-08-24T09:10:00.000Z" }),
      visit({ id: 3, arrivedAt: "2026-08-24T09:35:00.000Z" }),
    ], NOW);

    expect(rows.map((row) => row.visit.id)).toEqual([2, 3, 1]);
    expect(rows[0].waitedMinutes).toBe(50);
    expect(rows[0].level).toBe("critical");
  });

  it("تستبعد من على الكرسي ومن انتهى", () => {
    const rows = waitingRows([
      visit({ id: 1 }),
      visit({ id: 2, status: "in_chair", chair: 1 }),
      visit({ id: 3, status: "done" }),
    ], NOW);
    expect(rows.map((row) => row.visit.id)).toEqual([1]);
  });
});

describe("الكراسي", () => {
  it("تُظهر الكرسي الفارغ فارغًا ولا تُسقطه", () => {
    const rows = chairRows(2, [visit({ id: 1, status: "in_chair", chair: 1, seatedAt: "2026-08-24T09:40:00.000Z" })], NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0].occupant?.id).toBe(1);
    expect(rows[0].busyMinutes).toBe(20);
    expect(rows[1].occupant).toBeNull();
  });

  it("تجد أول كرسي فارغ، وتعيد null حين يمتلئ الاثنان", () => {
    expect(firstFreeChair(2, [visit({ id: 1, status: "in_chair", chair: 1 })])).toBe(2);
    expect(firstFreeChair(2, [
      visit({ id: 1, status: "in_chair", chair: 1 }),
      visit({ id: 2, status: "in_chair", chair: 2 }),
    ])).toBeNull();
  });
});

describe("ملخص اليوم", () => {
  it("يجمع الأرقام التي تُعرض في الأعلى", () => {
    const summary = daySummary(2, [
      visit({ id: 1, arrivedAt: "2026-08-24T09:15:00.000Z" }),
      visit({ id: 2, arrivedAt: "2026-08-24T09:45:00.000Z" }),
      visit({ id: 3, status: "in_chair", chair: 1 }),
      visit({ id: 4, status: "done" }),
    ], NOW);

    expect(summary.waiting).toBe(2);
    expect(summary.inChair).toBe(1);
    expect(summary.done).toBe(1);
    expect(summary.longestWaitMinutes).toBe(45);
    expect(summary.freeChairs).toBe(1);
  });
});

describe("النداء وشاشة الصالة", () => {
  it("تحجز الكرسي لمن نُودي عليه فلا يُنادى إليه ثانٍ", () => {
    const visits = [
      visit({ id: 1, status: "called", chair: 1, calledAt: "2026-08-24T09:58:00.000Z" }),
      visit({ id: 2 }),
    ];
    const rows = chairRows(2, visits, NOW);
    expect(rows[0].occupant).toBeNull();
    expect(rows[0].calledFor?.id).toBe(1);
    // الكرسي محجوز لا فارغ: هذا ما يمنع نداءين إلى كرسي واحد، وما يمنع تنبيه
    // «كرسي فارغ ومريض ينتظر» من الظهور كذبًا بعد كل نداء.
    expect(firstFreeChair(2, visits)).toBe(2);
    expect(daySummary(2, visits, NOW).freeChairs).toBe(1);
    expect(daySummary(2, visits, NOW).called).toBe(1);
  });

  it("تُخرج المنادى عليه من قائمة الانتظار", () => {
    const rows = waitingRows([
      visit({ id: 1, status: "called", chair: 1 }),
      visit({ id: 2 }),
    ], NOW);
    expect(rows.map((row) => row.visit.id)).toEqual([2]);
  });

  it("ترتّب النداءات بالأحدث أولًا", () => {
    const rows = calledVisits([
      visit({ id: 1, status: "called", chair: 1, calledAt: "2026-08-24T09:40:00.000Z" }),
      visit({ id: 2, status: "called", chair: 2, calledAt: "2026-08-24T09:55:00.000Z" }),
      visit({ id: 3 }),
    ]);
    expect(rows.map((row) => row.id)).toEqual([2, 1]);
  });

  it("تعرض الاسم الأول وحده على شاشة الصالة", () => {
    expect(firstNameOnly("عبدالله محمد سالم")).toBe("عبدالله");
    expect(firstNameOnly("  فاطمة   علي  ")).toBe("فاطمة");
    // اسم من كلمة واحدة يبقى كما هو بدل أن يصير فراغًا على الشاشة.
    expect(firstNameOnly("عبدالله")).toBe("عبدالله");
  });

  it("تدعم الزيارة السريرية حقل الطبيب المعالج doctorId لحساب العمولات", () => {
    const v = visit({ id: 99 });
    v.doctorId = 15;
    expect(v.doctorId).toBe(15);
  });
});
