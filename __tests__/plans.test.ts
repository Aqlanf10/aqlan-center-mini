import { describe, expect, it } from "vitest";
import { planProgress, splitInstallments, type PlanLike } from "../lib/plans";

describe("توزيع الأقساط", () => {
  it("يوزّع بالتساوي بلا أن يضيع ريال", () => {
    const parts = splitInstallments(1000000, 3, "2026-09-01");
    expect(parts.map((p) => p.amountMinor).reduce((a, b) => a + b, 0)).toBe(1000000);
  });

  it("يحمّل الكسر على القسط الأول لا الأخير", () => {
    // الأول يُدفع اليوم والمريض حاضر؛ والأخير بعد سنة وقد نُسي الاتفاق.
    const parts = splitInstallments(100, 3, "2026-09-01");
    expect(parts.map((p) => p.amountMinor)).toEqual([34, 33, 33]);
  });

  it("يباعد الاستحقاقات ثلاثين يومًا افتراضيًا", () => {
    const parts = splitInstallments(300, 3, "2026-09-01");
    expect(parts.map((p) => p.dueDate)).toEqual(["2026-09-01", "2026-10-01", "2026-10-31"]);
  });

  it("يحمي من عدد أقساط غير منطقي", () => {
    expect(splitInstallments(1000, 0, "2026-09-01")).toHaveLength(1);
    expect(splitInstallments(1000, 500, "2026-09-01")).toHaveLength(60);
  });
});

function plan(over: Partial<PlanLike> = {}): PlanLike {
  return {
    totalMinor: 900000,
    status: "active",
    installments: splitInstallments(900000, 9, "2026-06-01"),
    ...over,
  };
}

describe("حالة الخطة", () => {
  const TODAY = "2026-08-15"; // استحقّ ثلاثة أقساط: يونيو ويوليو وأغسطس

  it("يحسب المستحق حتى اليوم لا الإجمالي", () => {
    // مريضٌ اتفق على 900,000 ودفع 300,000 في شهره الثالث ليس متأخرًا بـ600,000 —
    // هو ملتزم تمامًا. والخلط يجعل كل مرضى التقويم يظهرون مدينين.
    const progress = planProgress(plan(), 300000, TODAY);
    expect(progress.dueToDateMinor).toBe(300000);
    expect(progress.overdueMinor).toBe(0);
    expect(progress.remainingMinor).toBe(600000);
  });

  it("يُظهر المتأخر حين يقصّر التحصيل عمّا استحقّ", () => {
    const progress = planProgress(plan(), 100000, TODAY);
    expect(progress.dueToDateMinor).toBe(300000);
    expect(progress.overdueMinor).toBe(200000);
    expect(progress.paidCount).toBe(1);
  });

  it("يشير إلى القسط القادم ومبلغه", () => {
    const progress = planProgress(plan(), 300000, TODAY);
    expect(progress.nextDueDate).toBe("2026-08-30");
    expect(progress.nextDueAmountMinor).toBe(100000);
  });

  it("يعتبر الدفع الزائد تغطية كاملة بلا رصيد سالب", () => {
    const progress = planProgress(plan(), 1200000, TODAY);
    expect(progress.remainingMinor).toBe(0);
    expect(progress.overdueMinor).toBe(0);
    expect(progress.paidCount).toBe(9);
  });

  it("يوزّع التحصيل على الأقساط بالأقدم أولًا", () => {
    // 150,000 تغطي القسط الأول كاملًا ونصف الثاني.
    const progress = planProgress(plan(), 150000, TODAY);
    expect(progress.paidCount).toBe(1);
    expect(progress.overdueMinor).toBe(150000);
  });
});
