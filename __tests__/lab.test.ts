import { describe, expect, it } from "vitest";
import {
  daysLate,
  defaultDueDate,
  filterOrders,
  isDueToday,
  isOverdue,
  labFollowUpText,
  labSummary,
  sortByUrgency,
  type LabOrder,
} from "../lib/lab";

const TODAY = "2026-08-27";

function order(over: Partial<LabOrder> & { id: number }): LabOrder {
  return {
    patientId: over.id,
    patientName: `مريض ${over.id}`,
    patientPhone: null,
    labName: "مختبر النور",
    labPhone: null,
    workType: "تاج",
    details: null,
    sentDate: "2026-08-20",
    dueDate: "2026-08-27",
    status: "sent",
    receivedAt: null,
    deliveredAt: null,
    note: null,
    visitId: null,
    toothCode: null,
    source: "manual",
    ...over,
  };
}

describe("تأخر أعمال المختبر", () => {
  it("يحسب أيام التأخير ويقرأ ما لم يحن موعده صفرًا لا رقمًا سالبًا", () => {
    expect(daysLate(order({ id: 1, dueDate: "2026-08-20" }), TODAY)).toBe(7);
    expect(daysLate(order({ id: 2, dueDate: "2026-08-27" }), TODAY)).toBe(0);
    // «متأخر ‎-3 أيام» جملة لا تعني شيئًا لمن يقرؤها بسرعة بين مريضين.
    expect(daysLate(order({ id: 3, dueDate: "2026-08-30" }), TODAY)).toBe(0);
  });

  it("لا يَعُدّ ما وصل أو رُكّب متأخرًا مهما مضى على موعده", () => {
    // العمل الذي وصل خرج من ذمّة المختبر؛ إبقاؤه في قائمة المتأخر يجعلها كذبًا يُتجاهل.
    expect(isOverdue(order({ id: 4, dueDate: "2026-07-01", status: "received" }), TODAY)).toBe(false);
    expect(isOverdue(order({ id: 5, dueDate: "2026-07-01", status: "delivered" }), TODAY)).toBe(false);
    expect(isOverdue(order({ id: 6, dueDate: "2026-07-01", status: "cancelled" }), TODAY)).toBe(false);
    expect(isOverdue(order({ id: 7, dueDate: "2026-07-01" }), TODAY)).toBe(true);
  });

  it("يميّز ما يستحق اليوم — الاتصال اليوم يمنع تأخر الغد", () => {
    expect(isDueToday(order({ id: 8, dueDate: TODAY }), TODAY)).toBe(true);
    expect(isDueToday(order({ id: 9, dueDate: "2026-08-26" }), TODAY)).toBe(false);
  });
});

describe("ترتيب القائمة وتصفيتها", () => {
  it("يضع الأكثر تأخّرًا أولًا لا الأحدث إرسالًا", () => {
    const orders = [
      order({ id: 1, sentDate: "2026-08-26", dueDate: "2026-09-26" }), // أُرسل أمس، مهلته شهر
      order({ id: 2, dueDate: "2026-08-20" }),                          // متأخر 7
      order({ id: 3, dueDate: "2026-08-25" }),                          // متأخر 2
    ];
    expect(sortByUrgency(orders, TODAY).map((o) => o.id)).toEqual([2, 3, 1]);
  });

  it("يصفّي حسب ما تحتاجه الاستقبال الآن", () => {
    const orders = [
      order({ id: 1, dueDate: "2026-08-20" }),
      order({ id: 2, status: "received" }),
      order({ id: 3, dueDate: "2026-09-10" }),
      order({ id: 4, status: "delivered" }),
    ];
    expect(filterOrders(orders, "late", TODAY).map((o) => o.id)).toEqual([1]);
    expect(filterOrders(orders, "outstanding", TODAY).map((o) => o.id)).toEqual([1, 3]);
    expect(filterOrders(orders, "received", TODAY).map((o) => o.id)).toEqual([2]);
    expect(filterOrders(orders, "all", TODAY)).toHaveLength(4);
  });

  it("يجمع أرقام اللوحة", () => {
    const summary = labSummary([
      order({ id: 1, dueDate: "2026-08-20" }),
      order({ id: 2, dueDate: TODAY }),
      order({ id: 3, dueDate: "2026-09-10" }),
      order({ id: 4, status: "received" }),
      order({ id: 5, status: "delivered" }),
    ], TODAY);
    expect(summary).toEqual({ outstanding: 3, late: 1, dueToday: 1, waitingFitting: 1 });
  });
});

describe("المهلة والرسائل", () => {
  it("يعطي مهلة افتراضية أسبوعًا من الإرسال", () => {
    expect(defaultDueDate("2026-08-27")).toBe("2026-09-03");
  });

  it("رسالة المتابعة تحمل التفاصيل التي تمنع مكالمة ثانية", () => {
    const text = labFollowUpText(
      order({ id: 1, patientName: "عبدالله سالم", dueDate: "2026-08-20", details: "6 علوي يمين" }),
      TODAY,
      "مركز الدكتور عقلان الكامل",
    );
    expect(text).toContain("عبدالله سالم");
    expect(text).toContain("تاج — 6 علوي يمين");
    expect(text).toContain("2026-08-20");
    expect(text).toContain("7 أيام");
  });

  it("رسالة عملٍ في موعده لا تتكلم عن تأخير", () => {
    const text = labFollowUpText(order({ id: 2, dueDate: "2026-09-05" }), TODAY, "المركز");
    expect(text).toContain("تأكيد الجاهزية");
    expect(text).not.toContain("مضى على الموعد");
  });
});
