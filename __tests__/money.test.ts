import { describe, expect, it } from "vitest";
import {
  balanceText,
  collectedBase,
  countDifference,
  formatMoney,
  invoiceNet,
  parseAmount,
  patientBalance,
  shiftTotals,
  toBaseAmount,
  type PaymentLike,
} from "../lib/money";

describe("قراءة المبالغ وكتابتها", () => {
  it("تقرأ ما تكتبه الاستقبال فعلًا", () => {
    expect(parseAmount("12500", "YER")).toBe(12500);
    expect(parseAmount("12,500", "YER")).toBe(12500);
    expect(parseAmount("١٢٥٠٠", "YER")).toBe(12500);
    expect(parseAmount("12.50", "USD")).toBe(1250);
    expect(parseAmount("١٢٫٥", "USD")).toBe(1250);
  });

  it("ترفض ما لا يُقرأ رقمًا بدل تخزين صفر بصمت", () => {
    for (const bad of ["", "abc", "12.5.5", "-3", "."]) {
      expect(parseAmount(bad, "YER")).toBeNull();
    }
  });

  it("تُخزَّن أعدادًا صحيحة فلا يتراكم خطأ الكسور العشرية", () => {
    // 0.1 + 0.2 في جافاسكربت ليست 0.3؛ الجمع بالوحدات الصغرى يعطي الرقم الصحيح.
    const cents = [parseAmount("0.10", "USD")!, parseAmount("0.20", "USD")!];
    expect(cents.reduce((a, b) => a + b, 0)).toBe(30);
    expect(formatMoney(30, "USD")).toBe("0.30 $");
  });

  it("تكتب الريال بلا كسور وبفواصل آلاف", () => {
    expect(formatMoney(1250000, "YER")).toBe("1,250,000 ر.ي");
    expect(formatMoney(150050, "SAR")).toBe("1,500.50 ر.س");
  });
});

describe("التحويل إلى العملة الأساسية", () => {
  it("يضرب الوحدة الكبرى في السعر لا الوحدة الصغرى", () => {
    // 12.50 دولارًا بسعر 530 = 6625 ريالًا. ضربُ السنتات في السعر كان يعطي مئة ضعف.
    expect(toBaseAmount(1250, "USD", "YER", 530)).toBe(6625);
    expect(toBaseAmount(10000, "SAR", "YER", 140)).toBe(14000);
  });

  it("لا يحوّل العملة الأساسية إلى نفسها", () => {
    expect(toBaseAmount(12500, "YER", "YER", 999)).toBe(12500);
  });
});

function payment(over: Partial<PaymentLike>): PaymentLike {
  return {
    amountMinor: 10000, currency: "YER", exchangeRate: 1,
    baseAmountMinor: 10000, kind: "payment", ...over,
  };
}

describe("رصيد المريض", () => {
  it("يحسب المفوتر ناقص المحصّل", () => {
    const balance = patientBalance(
      [{ totalMinor: 50000, discountMinor: 5000, status: "open" }],
      [payment({ baseAmountMinor: 20000 })],
    );
    expect(balance.billedMinor).toBe(45000);
    expect(balance.collectedMinor).toBe(20000);
    expect(balanceText(balance, "YER")).toBe("على المريض 25,000 ر.ي");
  });

  it("يضمّ الرصيد الافتتاحي إلى الحساب ويُبقيه بندًا مستقلًا", () => {
    // من كان عليه مئة ألف قبل التشغيل لا يصير حسابه صفرًا لأن النظام جديد. لكنه
    // يبقى منفصلًا عن المفوتر: ليس إيراد هذه الفترة ولا عمولة عليه.
    const balance = patientBalance(
      [{ totalMinor: 50000, discountMinor: 0, status: "open" }],
      [payment({ baseAmountMinor: 20000 })],
      100000,
    );
    expect(balance.openingMinor).toBe(100000);
    expect(balance.billedMinor).toBe(50000);
    expect(balance.dueMinor).toBe(130000);
    expect(balanceText(balance, "YER")).toBe("على المريض 130,000 ر.ي");
  });

  it("يبقى المفوتر وحده بلا رصيد افتتاحي", () => {
    const balance = patientBalance(
      [{ totalMinor: 50000, discountMinor: 0, status: "open" }],
      [],
    );
    expect(balance.openingMinor).toBe(0);
    expect(balance.dueMinor).toBe(50000);
  });

  it("يُظهر رصيد المريض عندنا سالبًا بدل إخفائه", () => {
    // إخفاؤه بجعل الأدنى صفرًا يعني أن تضيع أموال المرضى بصمت.
    const balance = patientBalance(
      [{ totalMinor: 10000, discountMinor: 0, status: "open" }],
      [payment({ baseAmountMinor: 13000 })],
    );
    expect(balance.dueMinor).toBe(-3000);
    expect(balanceText(balance, "YER")).toBe("للمريض 3,000 ر.ي");
  });

  it("يستبعد الفاتورة الملغاة ويطرح الاسترداد", () => {
    const balance = patientBalance(
      [
        { totalMinor: 50000, discountMinor: 0, status: "open" },
        { totalMinor: 90000, discountMinor: 0, status: "cancelled" },
      ],
      [payment({ baseAmountMinor: 50000 }), payment({ baseAmountMinor: 20000, kind: "refund" })],
    );
    expect(balance.billedMinor).toBe(50000);
    expect(collectedBase([payment({ baseAmountMinor: 50000 }), payment({ baseAmountMinor: 20000, kind: "refund" })])).toBe(30000);
    expect(balance.dueMinor).toBe(20000);
  });

  it("لا يجعل الخصم الزائد فاتورة سالبة", () => {
    expect(invoiceNet({ totalMinor: 10000, discountMinor: 30000, status: "open" })).toBe(0);
  });
});

describe("الوردية والجرد", () => {
  it("تفصل العملات لأن الجرد يُعدّ بالورق", () => {
    const totals = shiftTotals([
      payment({ amountMinor: 20000, currency: "YER", baseAmountMinor: 20000 }),
      payment({ amountMinor: 1000, currency: "USD", exchangeRate: 530, baseAmountMinor: 5300 }),
      payment({ amountMinor: 5000, currency: "YER", baseAmountMinor: 5000, kind: "refund" }),
    ]);
    expect(totals.byCurrency).toEqual({ YER: 15000, SAR: 0, USD: 1000 });
    expect(totals.baseTotalMinor).toBe(20300);
    expect(totals.paymentCount).toBe(3);
  });

  it("تحسب فرق الجرد لكل عملة على حدة", () => {
    const difference = countDifference(
      { YER: 15000, SAR: 0, USD: 1000 },
      { YER: 14000, SAR: 0, USD: 1000 },
    );
    expect(difference.YER).toBe(-1000);
    expect(difference.USD).toBe(0);
  });
});
