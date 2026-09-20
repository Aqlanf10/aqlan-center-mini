import { describe, expect, it } from "vitest";
import {
  allocateFifoByCurrency,
  commissionForPatient,
  summarizeCommissions,
  type CommissionInvoice,
} from "../lib/commission";
import { FinancialCurrencyIntegrityError } from "../lib/money";

describe("توزيع الدفعات على الفواتير — بدلو لكل عملة (تصحيح ٢)", () => {
  const invoices = [
    { id: 1, netMinor: 50000, createdAt: "2026-08-01T10:00:00Z", currency: "YER" as const },
    { id: 2, netMinor: 30000, createdAt: "2026-08-10T10:00:00Z", currency: "YER" as const },
  ];

  it("يغطّي الأقدم أولًا داخل الدلو", () => {
    const allocation = allocateFifoByCurrency(invoices, { YER: 60000, SAR: 0, USD: 0 });
    expect(allocation.get(1)).toBe(50000);
    expect(allocation.get(2)).toBe(10000);
  });

  it("لا ينسب الفائض إلى فاتورة — يبقى رصيدًا للمريض", () => {
    // ولو نُسب لحُسبت للطبيب عمولةٌ على مالٍ لم يقابله عمل.
    const allocation = allocateFifoByCurrency(invoices, { YER: 120000, SAR: 0, USD: 0 });
    expect(allocation.get(1)).toBe(50000);
    expect(allocation.get(2)).toBe(30000);
    expect([...allocation.values()].reduce((a, b) => a + b, 0)).toBe(80000);
  });

  it("يعطي نفس النتيجة مهما اختلف ترتيب الإدخال", () => {
    const reversed = [...invoices].reverse();
    expect(allocateFifoByCurrency(reversed, { YER: 60000, SAR: 0, USD: 0 }))
      .toEqual(allocateFifoByCurrency(invoices, { YER: 60000, SAR: 0, USD: 0 }));
  });

  it("تحصيل الدولار لا يغطّي فواتير اليمني — دلو لكل عملة", () => {
    // (تصحيح ٢) المزج القديم كان يوزّع محصّلًا واحدًا على فواتير بعملات مختلفة.
    const mixed = [
      { id: 1, netMinor: 100000, createdAt: "2026-08-01T10:00:00Z", currency: "YER" as const },
      { id: 2, netMinor: 10000, createdAt: "2026-08-05T10:00:00Z", currency: "USD" as const },
    ];
    const allocation = allocateFifoByCurrency(mixed, { YER: 0, SAR: 0, USD: 10000 });
    expect(allocation.get(1)).toBe(0);
    expect(allocation.get(2)).toBe(10000);
    const allocationYer = allocateFifoByCurrency(mixed, { YER: 100000, SAR: 0, USD: 0 });
    expect(allocationYer.get(1)).toBe(100000);
    expect(allocationYer.get(2)).toBe(0);
  });
});

function invoice(over: Partial<CommissionInvoice> & { id: number }): CommissionInvoice {
  return {
    netMinor: 100000,
    currency: "YER",
    createdAt: "2026-08-01T10:00:00Z",
    doctorShares: [{ doctorId: 7, amountMinor: 100000, currency: "YER" }],
    ...over,
  };
}

describe("عمولة الطبيب", () => {
  const percent = new Map([[7, 35]]);

  it("تُحسب على المحصّل لا على المفوتر", () => {
    // عمولةٌ على فاتورة لم تُحصَّل تعني أن يدفع صاحب العيادة من ماله عن مريض لم يدفع.
    const result = commissionForPatient([invoice({ id: 1 })], { YER: 0, SAR: 0, USD: 0 }, percent);
    expect(result.get(7)?.YER).toEqual({ accruedMinor: 35000, earnedMinor: 0 });
  });

  it("تتناسب مع نسبة التغطية لا كل-أو-لا-شيء", () => {
    // الكل-أو-لا-شيء يؤجّل عمولة الطبيب شهورًا على مريض يدفع أقساطًا.
    const result = commissionForPatient([invoice({ id: 1 })], { YER: 50000, SAR: 0, USD: 0 }, percent);
    expect(result.get(7)?.YER).toEqual({ accruedMinor: 35000, earnedMinor: 17500 });
  });

  it("تكتمل عند السداد الكامل", () => {
    const result = commissionForPatient([invoice({ id: 1 })], { YER: 100000, SAR: 0, USD: 0 }, percent);
    expect(result.get(7)?.YER.earnedMinor).toBe(35000);
  });

  it("توزّع بين طبيبين في فاتورة واحدة", () => {
    const shared = invoice({
      id: 1, netMinor: 100000,
      doctorShares: [
        { doctorId: 7, amountMinor: 60000, currency: "YER" },
        { doctorId: 8, amountMinor: 40000, currency: "YER" },
      ],
    });
    const result = commissionForPatient([shared], { YER: 100000, SAR: 0, USD: 0 }, new Map([[7, 35], [8, 50]]));
    expect(result.get(7)?.YER.earnedMinor).toBe(21000);
    expect(result.get(8)?.YER.earnedMinor).toBe(20000);
  });

  it("توزّع على كل الفواتير ثم تحسب المُصفَّاة وحدها", () => {
    // لو حُذفت القديمة قبل التوزيع لبدت دفعةٌ قديمة كأنها تغطّي فاتورة الشهر الحالي،
    // فتُصرف عمولة مرتين على مالٍ واحد.
    const invoices = [
      invoice({ id: 1, netMinor: 100000, createdAt: "2026-07-01T10:00:00Z" }),
      invoice({ id: 2, netMinor: 100000, createdAt: "2026-08-01T10:00:00Z" }),
    ];
    const august = (item: CommissionInvoice) => item.createdAt >= "2026-08-01";

    // 100,000 محصّلة تغطّي فاتورة يوليو كاملة ولا شيء من أغسطس.
    const result = commissionForPatient(invoices, { YER: 100000, SAR: 0, USD: 0 }, percent, august);
    expect(result.get(7)?.YER.earnedMinor).toBe(0);
    expect(result.get(7)?.YER.accruedMinor).toBe(35000);

    // ولو حُسبت فواتير أغسطس وحدها لبدت مغطّاة بالكامل — وهو الخطأ المقصود منعه.
    expect(
      commissionForPatient([invoices[1]], { YER: 100000, SAR: 0, USD: 0 }, percent).get(7)?.YER.earnedMinor,
    ).toBe(35000);
  });

  it("تتجاهل الطبيب بلا نسبة", () => {
    expect(commissionForPatient([invoice({ id: 1 })], { YER: 100000, SAR: 0, USD: 0 }, new Map()).size).toBe(0);
  });

  it("حصة بعملةٍ تخالف فاتورتها ترفع خطأ سلامةٍ — لا تُدار بصمت (تصحيح ٣)", () => {
    const corrupt = invoice({
      id: 1,
      doctorShares: [{ doctorId: 7, amountMinor: 100000, currency: "SAR" }],
    });
    expect(() =>
      commissionForPatient([corrupt], { YER: 100000, SAR: 0, USD: 0 }, percent),
    ).toThrow(FinancialCurrencyIntegrityError);
  });
});

describe("عمولة العملات المختلطة — طبيب واحد بثلاثة أرصدة منفصلة (تصحيح ٢)", () => {
  const percent = new Map([[7, 30]]);
  const yerIn = (id: number, netMinor: number, createdAt = "2026-08-01T10:00:00Z"): CommissionInvoice => ({
    id, netMinor, currency: "YER", createdAt,
    doctorShares: [{ doctorId: 7, amountMinor: netMinor, currency: "YER" }],
  });
  const sarIn = (id: number, netMinor: number, createdAt = "2026-08-01T10:00:00Z"): CommissionInvoice => ({
    id, netMinor, currency: "SAR", createdAt,
    doctorShares: [{ doctorId: 7, amountMinor: netMinor, currency: "SAR" }],
  });
  const usdIn = (id: number, netMinor: number, createdAt = "2026-08-01T10:00:00Z"): CommissionInvoice => ({
    id, netMinor, currency: "USD", createdAt,
    doctorShares: [{ doctorId: 7, amountMinor: netMinor, currency: "USD" }],
  });

  it("استحقاق بعملة كل فاتورة — لا تحويلًا صامتًا إلى يمني", () => {
    const result = commissionForPatient(
      [yerIn(1, 100000), sarIn(2, 20000), usdIn(3, 3000)],
      { YER: 50000, SAR: 20000, USD: 0 },
      percent,
    );
    expect(result.get(7)?.YER).toEqual({ accruedMinor: 30000, earnedMinor: 15000 });
    expect(result.get(7)?.SAR).toEqual({ accruedMinor: 6000, earnedMinor: 6000 });
    expect(result.get(7)?.USD).toEqual({ accruedMinor: 900, earnedMinor: 0 });
  });

  it("المصروف بعملةٍ لا يُطرح من استحقاق عملةٍ أخرى", () => {
    const perPatient = [
      new Map<number, Record<"YER" | "SAR" | "USD", { accruedMinor: number; earnedMinor: number }>>([[
        7,
        {
          YER: { accruedMinor: 30000, earnedMinor: 20000 },
          SAR: { accruedMinor: 6000, earnedMinor: 6000 },
          USD: { accruedMinor: 900, earnedMinor: 0 },
        },
      ]]),
    ];
    // صُرف له سعودي فقط: يمنيُّه ودولاريُّه لا يُمسّان.
    const summary = summarizeCommissions(perPatient, new Map([[7, { YER: 0, SAR: 6000, USD: 0 }]]));
    const yer = summary.find((row) => row.doctorId === 7 && row.currency === "YER")!;
    const sar = summary.find((row) => row.doctorId === 7 && row.currency === "SAR")!;
    const usd = summary.find((row) => row.doctorId === 7 && row.currency === "USD")!;
    expect(yer.dueMinor).toBe(20000);
    expect(sar.dueMinor).toBe(0);
    expect(usd.dueMinor).toBe(0);
  });

  it("الترتيب داخل العملة فقط — لا مقارنة عابرة بالوحدات الصغرى", () => {
    const perPatient = [
      new Map<number, Record<"YER" | "SAR" | "USD", { accruedMinor: number; earnedMinor: number }>>([[
        7,
        {
          YER: { accruedMinor: 0, earnedMinor: 5000 },
          SAR: { accruedMinor: 0, earnedMinor: 500000 },
          USD: { accruedMinor: 0, earnedMinor: 0 },
        },
      ]]),
    ];
    const summary = summarizeCommissions(perPatient, new Map());
    expect(summary.map((row) => row.currency)).toEqual(["YER", "SAR"]);
  });
});

describe("ملخص العمولات", () => {
  it("يطرح المدفوع بعملته ويُظهر الصرف بلا استحقاق", () => {
    const summary = summarizeCommissions(
      [new Map([[7, {
        YER: { accruedMinor: 35000, earnedMinor: 20000 },
        SAR: { accruedMinor: 0, earnedMinor: 0 },
        USD: { accruedMinor: 0, earnedMinor: 0 },
      }]])],
      new Map([
        [7, { YER: 12000, SAR: 0, USD: 0 }],
        [9, { YER: 5000, SAR: 0, USD: 0 }],
      ]),
    );
    const seven = summary.find((row) => row.doctorId === 7 && row.currency === "YER")!;
    expect(seven.dueMinor).toBe(8000);
    // طبيبٌ صُرف له بلا استحقاق محسوب يجب أن يُرى لا أن يختفي من التقرير.
    const nine = summary.find((row) => row.doctorId === 9 && row.currency === "YER")!;
    expect(nine.earnedMinor).toBe(0);
    expect(nine.dueMinor).toBe(-5000);
  });
});
