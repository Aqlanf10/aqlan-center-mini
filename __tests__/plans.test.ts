import { describe, expect, it } from "vitest";
import {
  canConsent,
  canEditItems,
  itemsTotal,
  matchPlanItems,
  planItemsProgress,
  planLedgerSummary,
  planProgress,
  splitInstallments,
  type PlanItemLike,
  type PlanItemStatus,
  type PlanLike,
} from "../lib/plans";

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

describe("بنود الخطة السريرية", () => {
  const item = (over: Partial<PlanItemLike> & { id?: number } = {}) => ({
    id: over.id ?? 1,
    serviceId: over.serviceId ?? 7,
    toothCode: over.toothCode ?? null,
    quantity: over.quantity ?? 1,
    unitPriceMinor: over.unitPriceMinor ?? 10_000,
    status: over.status ?? ("planned" as PlanItemStatus),
  });

  it("الإجمالي يُشتقّ من البنود، والملغى لا يُحسب", () => {
    expect(itemsTotal([
      item({ unitPriceMinor: 10_000 }),
      item({ unitPriceMinor: 5_000, quantity: 3 }),
      item({ unitPriceMinor: 99_000, status: "cancelled" }),
    ])).toBe(25_000);
  });

  it("تقدّم العلاج غير تقدّم الدفع: يُحسب من المنفَّذ لا من المحصَّل", () => {
    const progress = planItemsProgress([
      item({ id: 1, unitPriceMinor: 30_000, status: "done" }),
      item({ id: 2, unitPriceMinor: 20_000 }),
      item({ id: 3, unitPriceMinor: 50_000, status: "cancelled" }),
    ]);
    expect(progress).toMatchObject({
      count: 2, doneCount: 1, totalMinor: 50_000, doneMinor: 30_000, remainingMinor: 20_000,
    });
  });

  it("لا موافقة على خطة فارغة ولا موافقة مرتين", () => {
    expect(canConsent({ status: "active", consentAt: null, items: [] }).ok).toBe(false);
    expect(canConsent({ status: "active", consentAt: null, items: [item()] }).ok).toBe(true);
    expect(canConsent({ status: "active", consentAt: "2026-01-01T00:00:00Z", items: [item()] }).ok).toBe(false);
    expect(canConsent({ status: "cancelled", consentAt: null, items: [item()] }).ok).toBe(false);
  });

  it("بعد الموافقة تُقفل البنود", () => {
    expect(canEditItems({ status: "active", consentAt: null }).ok).toBe(true);
    const locked = canEditItems({ status: "active", consentAt: "2026-01-01T00:00:00Z" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.message).toContain("خطة جديدة");
  });

  it("الزيارة تشطب بنودها: مطابقة بالخدمة والسن معًا", () => {
    const items = [
      item({ id: 1, serviceId: 7, toothCode: 16 }),
      item({ id: 2, serviceId: 7, toothCode: 26 }),
      item({ id: 3, serviceId: 9, toothCode: null }),
    ];
    expect(matchPlanItems(items, [{ serviceId: 7, toothCode: 16, quantity: 1 }])).toEqual([1]);
    expect(matchPlanItems(items, [{ serviceId: 9, toothCode: null, quantity: 1 }])).toEqual([3]);
    // حشوة على سنّ ليس في الخطة لا تشطب حشوة سنّ آخر
    expect(matchPlanItems(items, [{ serviceId: 7, toothCode: 36, quantity: 1 }])).toEqual([]);
    // إجراءان يشطبان بندين
    expect(matchPlanItems(items, [
      { serviceId: 7, toothCode: 16, quantity: 1 },
      { serviceId: 7, toothCode: 26, quantity: 1 },
    ])).toEqual([1, 2]);
  });

  it("البند المنفَّذ لا يُشطب مرتين", () => {
    const items = [item({ id: 1, serviceId: 7, toothCode: 16, status: "done" })];
    expect(matchPlanItems(items, [{ serviceId: 7, toothCode: 16, quantity: 1 }])).toEqual([]);
  });

  it("الملغى لا يُشطب", () => {
    const items = [item({ id: 1, serviceId: 7, toothCode: 16, status: "cancelled" })];
    expect(matchPlanItems(items, [{ serviceId: 7, toothCode: 16, quantity: 1 }])).toEqual([]);
  });
});

describe("الخطة كما تُقرأ في كشف الحساب", () => {
  const installmentPlan = (overrides: Partial<Parameters<typeof planLedgerSummary>[0]> = {}) => ({
    id: 1, title: "تقويم ثابت — فكّان", status: "active" as const, totalMinor: 1_000_000,
    consentAt: "2026-08-01T09:00:00Z",
    installments: splitInstallments(1_000_000, 10, "2026-08-01"),
    progress: planProgress(
      { totalMinor: 1_000_000, status: "active" as const, installments: splitInstallments(1_000_000, 10, "2026-08-01") },
      300_000, "2026-08-31",
    ),
    itemsProgress: planItemsProgress([]),
    ...overrides,
  });

  it("خطة الأقساط تحمل قصتها المالية لا قصة البنود", () => {
    const summary = planLedgerSummary(installmentPlan());
    expect(summary.installments).not.toBeNull();
    expect(summary.items).toBeNull();
    expect(summary.installments?.paidMinor).toBe(300_000);
    expect(summary.installments?.remainingMinor).toBe(700_000);
    expect(summary.installments?.paidCount).toBe(3);
    expect(summary.consented).toBe(true);
  });

  it("خطة البنود تحمل قصة العمل — مالها من فواتير زياراتها لا منها", () => {
    const summary = planLedgerSummary(installmentPlan({
      title: "خطة علاج ترميمي",
      consentAt: null,
      installments: [],
      itemsProgress: planItemsProgress([
        { serviceId: 3, toothCode: 16, quantity: 1, unitPriceMinor: 45_000, status: "done" },
        { serviceId: 5, toothCode: 16, quantity: 1, unitPriceMinor: 20_000, status: "planned" },
      ]),
    }));
    expect(summary.items).not.toBeNull();
    expect(summary.installments).toBeNull();
    expect(summary.items?.count).toBe(2);
    expect(summary.items?.doneCount).toBe(1);
    expect(summary.items?.doneMinor).toBe(45_000);
    expect(summary.items?.remainingMinor).toBe(20_000);
    expect(summary.consented).toBe(false);
  });

  it("المتأخر والقادم يمرّان كما حسبهما planProgress بلا إعادة حساب شاشة", () => {
    const plan = installmentPlan();
    const summary = planLedgerSummary(plan);
    expect(summary.installments?.overdueMinor).toBe(plan.progress.overdueMinor);
    expect(summary.installments?.nextDueDate).toBe(plan.progress.nextDueDate);
    expect(summary.installments?.nextDueAmountMinor).toBe(plan.progress.nextDueAmountMinor);
    expect(summary.totalMinor).toBe(plan.totalMinor);
    expect(summary.status).toBe("active");
  });
});
