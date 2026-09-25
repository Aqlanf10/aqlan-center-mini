import { describe, expect, it } from "vitest";
import { classifyLabWork, hasPendingLabWork, labReadinessFor, type PatientLabWork } from "@/lib/lab-readiness";

const TODAY = "2026-09-25";
const VISIT = "2026-09-27";

function work(overrides: Partial<PatientLabWork>): PatientLabWork {
  return {
    orderId: 1, patientId: 7, workType: "تاج زيركون", labName: "مختبر النور", status: "sent", dueDate: "2026-09-26",
    ...overrides,
  };
}

describe("classifyLabWork", () => {
  it("وصلت العيادة ⇒ جاهزة", () => {
    expect(classifyLabWork(work({ status: "received" }), VISIT, TODAY)).toMatchObject({
      level: "ready", message: "تاج زيركون: وصلت العيادة — جاهزة للتركيب",
    });
  });

  it("لم تُرسل للمختبر ⇒ not_sent مهما كان تاريخها", () => {
    expect(classifyLabWork(work({ status: "needed", dueDate: "2026-09-01" }), VISIT, TODAY).level).toBe("not_sent");
  });

  it("تجاوزت استحقاقها وما زالت عند المختبر ⇒ متأخرة بعدد الأيام واسم المختبر", () => {
    const item = classifyLabWork(work({ dueDate: "2026-09-22" }), VISIT, TODAY);
    expect(item.level).toBe("late");
    expect(item.message).toBe("تاج زيركون: متأخرة عند مختبر النور 3 يوم — اتصل بالمختبر");
  });

  it("استحقاقها بعد الموعد ⇒ لن تكون جاهزة", () => {
    const item = classifyLabWork(work({ status: "in_progress", dueDate: "2026-09-30" }), VISIT, TODAY);
    expect(item.level).toBe("after_visit");
    expect(item.message).toContain("2026-09-30 بعد الموعد");
  });

  it("متوقعة قبل الموعد أو يومه ولم تصل ⇒ awaiting", () => {
    expect(classifyLabWork(work({ dueDate: VISIT }), VISIT, TODAY).level).toBe("awaiting");
    expect(classifyLabWork(work({ status: "remake", dueDate: TODAY }), VISIT, TODAY).level).toBe("awaiting");
  });
});

describe("labReadinessFor / hasPendingLabWork", () => {
  it("الأخطر أولًا، والجاهز أخيرًا", () => {
    const items = labReadinessFor([
      work({ orderId: 1, status: "received" }),
      work({ orderId: 2, dueDate: "2026-09-30" }),
      work({ orderId: 3, dueDate: "2026-09-20" }),
      work({ orderId: 4, status: "needed" }),
    ], VISIT, TODAY);
    expect(items.map((item) => item.level)).toEqual(["late", "not_sent", "after_visit", "ready"]);
    expect(hasPendingLabWork(items)).toBe(true);
  });

  it("كل الأعمال وصلت ⇒ لا تنبيه", () => {
    expect(hasPendingLabWork(labReadinessFor([work({ status: "received" })], VISIT, TODAY))).toBe(false);
    expect(hasPendingLabWork(undefined)).toBe(false);
    expect(hasPendingLabWork([])).toBe(false);
  });
});

describe("مُنتظَرو اليوم على الشاشة الرئيسية", () => {
  it("من ينتظر عمل مختبرٍ لم يصل يُعلَّم، ومن وصلت تركيبته لا", async () => {
    const { expectedArrivals } = await import("@/lib/arrivals");
    const base = {
      patientName: "س", patientPhone: null, scheduledDate: VISIT, durationMinutes: 30, note: null, status: "booked" as const,
    };
    const rows = expectedArrivals([
      { ...base, id: 1, patientId: 1, scheduledTime: "10:00",
        labReadiness: labReadinessFor([work({ status: "sent", dueDate: "2026-09-30" })], VISIT, TODAY) },
      { ...base, id: 2, patientId: 2, scheduledTime: "11:00",
        labReadiness: labReadinessFor([work({ status: "received" })], VISIT, TODAY) },
      { ...base, id: 3, patientId: 3, scheduledTime: "12:00" },
    ], "09:00");
    expect(rows.map((row) => row.labPending)).toEqual([true, false, false]);
  });
});
