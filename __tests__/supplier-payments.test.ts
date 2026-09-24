import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  convertMinor, crossRateText, isGuardedPartyKind, maxPaymentFor, partyOutstandingIn, refusalMessage,
} from "../lib/supplier-payments";
import { parseExpenseRequest } from "../lib/expense-request";
import { SUPPLIER_PAYMENT_SETTLEMENT_SQL } from "../lib/supplier-payment-schema";

/** (P0-2) المنطق الخالص لسداد الموردين: التحويل بسعر اللحظة، والحدود، وقراءة الطلب. */
const RATES = { SAR: 140, USD: 535 } as const;

describe("التحويل بسعر لحظة الدفع", () => {
  it("مثال المالك: ٢٦٬٧٥٠ ريالًا بسعر ٥٣٥ = ٥٠٫٠٠ دولارًا", () => {
    expect(convertMinor(26_750, "YER", "USD", RATES)).toBe(5_000);
    expect(convertMinor(5_000, "USD", "YER", RATES)).toBe(26_750);
  });

  it("عملتان أجنبيتان عبر سعريهما إلى الأساس — لا سعر ثالث", () => {
    expect(convertMinor(37_500, "SAR", "USD", RATES)).toBe(9_813);
  });

  it("السعر الغائب لا يُخمَّن", () => {
    expect(convertMinor(100, "YER", "USD", {})).toBeNull();
    expect(convertMinor(100, "USD", "USD", {})).toBe(100);
  });

  it("أقصى مبلغٍ بعملة الدفع لا يتجاوز مكافئه المتبقي", () => {
    const max = maxPaymentFor(5_000, "YER", "USD", RATES)!;
    expect(convertMinor(max, "YER", "USD", RATES)).toBeLessThanOrEqual(5_000);
    expect(convertMinor(max + 3, "YER", "USD", RATES)).toBeGreaterThan(5_000);
    expect(maxPaymentFor(0, "YER", "USD", RATES)).toBe(0);
  });

  it("رصيد الجهة: الدلاء تُحوَّل ثم تُجمع — ودلوٌ بلا سعر يُوقف الحساب", () => {
    expect(partyOutstandingIn("YER", [{ currency: "USD", netMinor: 10_000 }, { currency: "YER", netMinor: 20_000 }], RATES))
      .toBe(73_500);
    expect(partyOutstandingIn("YER", [{ currency: "USD", netMinor: 1 }], {})).toBeNull();
    expect(partyOutstandingIn("YER", [{ currency: "USD", netMinor: 0 }], {})).toBe(0);
  });

  it("نصّ السعر كما يُكتب في الصرافات", () => {
    expect(crossRateText("YER", "USD", RATES)).toBe("1 USD = 535 YER");
    expect(crossRateText("USD", "YER", RATES)).toBe("1 USD = 535 YER");
    expect(crossRateText("YER", "YER", RATES)).toBeNull();
  });

  it("الأطباء خارج حارس الرصيد (لهم تقرير العمولات)", () => {
    expect(isGuardedPartyKind("lab")).toBe(true);
    expect(isGuardedPartyKind("supplier")).toBe(true);
    expect(isGuardedPartyKind("doctor")).toBe(false);
    expect(isGuardedPartyKind(null)).toBe(false);
  });

  it("رسائل الرفض عربية وتذكر المتبقي", () => {
    const message = refusalMessage("exceeds_payable", {
      paymentCurrency: "YER", amountMinor: 27_000, paymentExchangeRate: 1, baseAmountMinor: 27_000,
      rateText: "1 USD = 535 YER", rateOverridden: false, party: null,
      payable: {
        id: 1, currency: "USD", amountMinor: 10_000, exchangeRate: 535, remainingBeforeMinor: 5_000,
        settledMinor: 5_047, remainingAfterMinor: -47, maxPaymentMinor: 26_752,
      },
    });
    expect(message).toContain("المتبقي");
    expect(message).toMatch(/[؀-ۿ]/);
  });
});

describe("قراءة طلب سند الصرف — السعر من الإعدادات والتعديل للمدير بسبب", () => {
  const base = { category: "supplier", partyId: 3, amount: "26750", currency: "YER" };

  it("السعر من الإعدادات دائمًا", () => {
    const parsed = parseExpenseRequest({ ...base, currency: "USD", amount: "10" }, RATES, false);
    expect(parsed).toMatchObject({ ok: true, value: { exchangeRate: 535, rateOverrideReason: null } });
  });

  it("غير المدير لا يعدّل السعر، والمدير يعدّله بسببٍ فقط", () => {
    expect(parseExpenseRequest({ ...base, currency: "USD", amount: "10", exchangeRate: 540 }, RATES, false))
      .toMatchObject({ ok: false, status: 403 });
    expect(parseExpenseRequest({ ...base, currency: "USD", amount: "10", exchangeRate: 540 }, RATES, true))
      .toMatchObject({ ok: false, status: 400 });
    expect(parseExpenseRequest({ ...base, currency: "USD", amount: "10", exchangeRate: 540, rateOverrideReason: "سعر الصرّاف" }, RATES, true))
      .toMatchObject({ ok: true, value: { exchangeRate: 540, rateOverrideReason: "سعر الصرّاف" } });
    expect(parseExpenseRequest({ ...base, payableId: 9, payableExchangeRate: 540 }, RATES, false))
      .toMatchObject({ ok: false, status: 403 });
  });

  it("الدفعة المقدمة للمدير وحده وبسبب", () => {
    expect(parseExpenseRequest({ ...base, prepayment: true, prepaymentReason: "حجز" }, RATES, false))
      .toMatchObject({ ok: false, status: 403 });
    expect(parseExpenseRequest({ ...base, prepayment: true }, RATES, true)).toMatchObject({ ok: false, status: 400 });
    expect(parseExpenseRequest({ ...base, prepayment: true, prepaymentReason: "حجز شحنة" }, RATES, true))
      .toMatchObject({ ok: true, value: { prepaymentReason: "حجز شحنة" } });
  });

  it("سعرٌ غير صالح أو غائب يُرفض برسالة عربية", () => {
    expect(parseExpenseRequest({ ...base, currency: "USD", amount: "10", exchangeRate: -1 }, RATES, true))
      .toMatchObject({ ok: false, status: 400 });
    expect(parseExpenseRequest({ ...base, currency: "USD", amount: "10" }, {}, true))
      .toMatchObject({ ok: false, status: 409 });
  });
});

describe("مسارا المخطط لا يفترقان (0013)", () => {
  it("جسد migrations/0013 = SUPPLIER_PAYMENT_SETTLEMENT_SQL حرفيًّا", () => {
    const migration = readFileSync("migrations/0013_supplier_payment_settlement.sql", "utf8");
    const lines = migration.split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(`${lines.slice(index).join("\n").replace(/\n+$/, "")}\n`).toBe(SUPPLIER_PAYMENT_SETTLEMENT_SQL);
  });

  it("اللقطة محروسة والبذر لا يمسّ سندًا له لقطة", () => {
    expect(SUPPLIER_PAYMENT_SETTLEMENT_SQL).toMatch(/BEFORE UPDATE ON expenses/);
    expect(SUPPLIER_PAYMENT_SETTLEMENT_SQL).toMatch(/AND e\.payable_settled_minor IS NULL/);
  });
});
