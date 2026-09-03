import { describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  ACCOUNT_BY_CODE,
  EXPENSE_ACCOUNT,
  STANDARD_EXPENSE_ACCOUNTS,
  expenseEntry,
} from "../lib/accounting";
import { CLINIC_BASE_CURRENCY } from "../lib/money";
import {
  BILLING_RULE_LABEL,
  BILLING_STATUS_LABEL,
  PRICING_MODE_LABEL,
  PAYMENT_MODE_LABEL,
  groupItemsByVisit,
  installmentReminderText,
  planProgress,
} from "../lib/plans";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, isExpenseCategory } from "../lib/expenses";
import { filterOrders, LAB_FILTER_LABEL, type LabOrder } from "../lib/lab";
import type { PlanItemLike, PlanItemStatus } from "../lib/plans";

/**
 * اختبارات الميزانية المدمجة من عمل الوكيل الآخر (الحزمة المالية):
 * بنود المصروفات والموازنات، الترحيل المحاسبي لأوامر المختبر،
 * وتتبع تذكيرات أقساط خطط العلاج — المنطق الخالص بلا قاعدة بيانات.
 */

const TODAY = "2026-09-03";

describe("دليل الحسابات الموسّع (بنود المصروفات)", () => {
  it("يضم حسابي صيانة المقر والتسويق الجديدين", () => {
    expect(ACCOUNT_BY_CODE.get("5504")?.name).toContain("صيانة المقر");
    expect(ACCOUNT_BY_CODE.get("5902")?.name).toContain("التسويق");
    expect(ACCOUNTS.some((a) => a.code === "5504" && a.kind === "expense")).toBe(true);
    expect(ACCOUNTS.some((a) => a.code === "5902" && a.kind === "expense")).toBe(true);
  });

  it("يربط كل بند مصروف قياسي بحسابه في الدليل", () => {
    for (const [category, code] of Object.entries(EXPENSE_ACCOUNT)) {
      expect(ACCOUNT_BY_CODE.has(code), `الحساب ${code} لبند ${category} يجب أن يكون في الدليل`).toBe(true);
    }
    expect(EXPENSE_ACCOUNT.electricity).toBe("5502");
    expect(EXPENSE_ACCOUNT.marketing).toBe("5902");
    expect(EXPENSE_ACCOUNT.facility_maintenance).toBe("5504");
    expect(EXPENSE_ACCOUNT.rent).toBe("5501");
  });

  it("يعرض الحسابين الجديدين في قائمة الحسابات القياسية للمصروفات", () => {
    expect(STANDARD_EXPENSE_ACCOUNTS.some((a) => a.code === "5504")).toBe(true);
    expect(STANDARD_EXPENSE_ACCOUNTS.some((a) => a.code === "5902")).toBe(true);
  });

  it("قيد المصروف المتأخر يجد بيته: الإدخال يعمل مع الأكواد الجديدة", () => {
    const entry = expenseEntry({
      voucherNumber: "EXP-5504",
      date: TODAY,
      payeeName: "سبّاك المقر",
      category: "facility_maintenance",
      currency: "YER",
      baseAmountMinor: 250_000,
      settlesPayable: false,
      expenseAccountCode: "5504",
    });
    expect(entry).not.toBeNull();
    expect(entry!.lines[0].accountCode).toBe("5504");
  });

  it("عملة القاعدة معرفة للجميع: الريال اليمني", () => {
    expect(CLINIC_BASE_CURRENCY).toBe("YER");
  });
});

describe("تصنيفات المصروفات المفتوحة", () => {
  it("تعرف البنود التشغيلية الأربعة عشر مع تسمياتها العربية", () => {
    expect(EXPENSE_CATEGORIES).toContain("electricity");
    expect(EXPENSE_CATEGORIES).toContain("facility_maintenance");
    expect(EXPENSE_CATEGORIES).toContain("marketing");
    expect(EXPENSE_CATEGORY_LABEL.electricity).toContain("الكهرباء");
    expect(EXPENSE_CATEGORY_LABEL.facility_maintenance).toContain("السباكة");
    expect(EXPENSE_CATEGORY_LABEL.marketing).toContain("التسويق");
  });

  it("تقبل مفاتيح مخصصة (بنود أنشأها المالك) وترفض الصيغ الفاسدة", () => {
    expect(isExpenseCategory("cat_abc123")).toBe(true);
    expect(isExpenseCategory("")).toBe(false);
    expect(isExpenseCategory("بند عربي")).toBe(false);
  });
});

describe("فلتر أوامر المختبر: بانتظار الترحيل المحاسبي", () => {
  const baseOrder = { id: 1, patientId: 1, patientName: "مريض", workType: "تاج" };

  function labOrder(over: Partial<LabOrder>): LabOrder {
    return {
      ...baseOrder,
      status: "sent",
      labName: "مختبر النور",
      sentDate: TODAY,
      dueDate: TODAY,
      ...over,
    } as LabOrder;
  }

  it("يعرض أوامر ذات تكلفة غير مرحّلة فقط", () => {
    const orders: LabOrder[] = [
      labOrder({ id: 1, costMinor: 50_000, isPosted: false }),
      labOrder({ id: 2, costMinor: 50_000, isPosted: true }),
      labOrder({ id: 3, costMinor: null, isPosted: false }),
      labOrder({ id: 4, costMinor: 50_000 }), // isPosted غائب = مُرحّل افتراضيًّا
    ];
    const unposted = filterOrders(orders, "unposted", TODAY);
    expect(unposted.map((o) => o.id)).toEqual([1]);
  });

  it("التسمية العربية للفلتر موجودة", () => {
    expect(LAB_FILTER_LABEL.unposted).toContain("الترحيل");
  });
});

describe("تجميع بنود الخطة في جلسات مخططة", () => {
  function item(id: number, over: Partial<PlanItemLike> = {}): PlanItemLike {
    return {
      id,
      serviceId: null,
      serviceName: `خدمة ${id}`,
      toothCode: null,
      surfaces: null,
      quantity: 1,
      unitPriceMinor: 10_000,
      totalMinor: 10_000,
      status: "planned" as PlanItemStatus,
      ...over,
    };
  }

  it("يجمع البنود برقم الجلسة ويعرض إجمالي كل جلسة", () => {
    const groups = groupItemsByVisit([
      item(1, { plannedVisitNumber: 2 }),
      item(2, { plannedVisitNumber: 1 }),
      item(3, { plannedVisitNumber: 2 }),
      item(4, { plannedVisitNumber: 1 }),
      item(5, { status: "cancelled" }),
    ]);
    expect(groups.map((g) => g.visitNumber)).toEqual([1, 2]);
    expect(groups[0].items.map((i) => i.id)).toEqual([2, 4]);
    expect(groups[1].items.map((i) => i.id)).toEqual([1, 3]);
    expect(groups[0].totalMinor).toBe(20_000);
    expect(groups[0].doneCount).toBe(0);
    expect(groups[0].allDone).toBe(false);
  });

  it("البنود بلا جلسة تتبع الجلسة الأولى، والملغاة لا تُحسب", () => {
    const groups = groupItemsByVisit([
      item(1, { status: "done" }),
      item(2, { status: "cancelled", plannedVisitNumber: 3 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].visitNumber).toBe(1);
    expect(groups[0].doneCount).toBe(1);
    expect(groups[0].allDone).toBe(true);
  });

  it("قوائم التسميات الكاملة للفوترة والتسعير والدفع", () => {
    expect(BILLING_RULE_LABEL.per_session).toContain("الجلسات");
    expect(BILLING_STATUS_LABEL.unbilled).toContain("غير مفوتر");
    expect(PRICING_MODE_LABEL.package).toContain("باقة");
    expect(PAYMENT_MODE_LABEL.installments).toContain("أقساط");
  });
});

describe("تتبع آخر تذكير لأقساط الخطة", () => {
  it("تقدم الخطة يرفع آخر تذكير من الخطة أو أي قسط", () => {
    const progress = planProgress(
      {
        totalMinor: 300_000,
        status: "active",
        lastReminderAt: "2026-09-01T10:00:00.000Z",
        installments: [
          { number: 1, dueDate: "2026-08-01", amountMinor: 100_000, lastReminderAt: "2026-08-20T08:00:00.000Z" },
          { number: 2, dueDate: "2026-09-01", amountMinor: 100_000 },
          { number: 3, dueDate: "2026-10-01", amountMinor: 100_000, lastReminderAt: "2026-09-02T09:00:00.000Z" },
        ],
      },
      100_000,
      TODAY,
    );
    expect(progress.lastReminderAt).toBe("2026-09-02T09:00:00.000Z");
  });

  it("نص تذكير القسط يذكر المبلغ والموعد واسم المركز", () => {
    const text = installmentReminderText({
      patientName: "أحمد",
      amountText: "50,000 ر.ي",
      dueDateText: "1 سبتمبر 2026",
      overdue: true,
      clinicName: "مركز عقلان",
      clinicPhone: "777123456",
    });
    expect(text).toContain("أحمد");
    expect(text).toContain("المستحق");
    expect(text).toContain("50,000");
    expect(text).toContain("مركز عقلان");
  });
});
