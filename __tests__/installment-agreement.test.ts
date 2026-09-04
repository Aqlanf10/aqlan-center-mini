import { describe, expect, it } from "vitest";
import { buildInstallmentPlanAgreement, STANDARD_PLAN_TERMS } from "../lib/plans";

describe("اتفاقية وعقد خطة العلاج والأقساط", () => {
  it("يبني بيانات العقد ويوزع السداد على الأقساط بالأقدم أولاً", () => {
    const agreement = buildInstallmentPlanAgreement({
      planId: 101,
      patientName: "أحمد علي",
      patientPhone: "770245745",
      planTitle: "خطة تقويم أسنان معدني شامل الفكين",
      totalMinor: 600000,
      baseCurrency: "YER",
      startDate: "2026-09-01",
      note: "حالة تراكب في القواطع العلوية",
      installments: [
        { number: 1, dueDate: "2026-09-01", amountMinor: 200000 },
        { number: 2, dueDate: "2026-10-01", amountMinor: 200000 },
        { number: 3, dueDate: "2026-11-01", amountMinor: 200000 },
      ],
      paidMinor: 250000, // covers 1st installment completely, and 50,000 of 2nd
    });

    expect(agreement.planId).toBe(101);
    expect(agreement.patientName).toBe("أحمد علي");
    expect(agreement.patientPhone).toBe("770245745");
    expect(agreement.installments).toHaveLength(3);

    // First installment is fully paid
    expect(agreement.installments[0].number).toBe(1);
    expect(agreement.installments[0].paid).toBe(true);

    // Second installment is only partially paid (not covered fully)
    expect(agreement.installments[1].number).toBe(2);
    expect(agreement.installments[1].paid).toBe(false);

    // Third installment is completely unpaid
    expect(agreement.installments[2].number).toBe(3);
    expect(agreement.installments[2].paid).toBe(false);

    // Uses standard clinical terms by default
    expect(agreement.terms).toEqual(STANDARD_PLAN_TERMS);
    expect(agreement.terms.length).toBeGreaterThan(3);
  });

  it("يقبل شروطاً خاصة بالعيادة أو المريض", () => {
    const customTerms = ["شرط مخصص: يجب استخدام مثبت شفاف بعد انتهاء التقويم"];
    const agreement = buildInstallmentPlanAgreement({
      planId: 102,
      patientName: "سارة محمد",
      planTitle: "زراعة أسنان فورية",
      totalMinor: 400,
      baseCurrency: "USD",
      startDate: "2026-09-04",
      installments: [{ number: 1, dueDate: "2026-09-04", amountMinor: 400 }],
      paidMinor: 400,
      customTerms,
    });

    expect(agreement.terms).toEqual(customTerms);
    expect(agreement.installments[0].paid).toBe(true);
  });
});
