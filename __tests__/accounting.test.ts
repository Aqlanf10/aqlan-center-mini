import { describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  AP_ACCOUNT,
  AR_ACCOUNT,
  CASH_ACCOUNT,
  DISCOUNT_ACCOUNT,
  REVENUE_ACCOUNT,
  balanceSheet,
  cashDifferenceEntry,
  expenseEntry,
  incomeStatement,
  invoiceEntry,
  isBalanced,
  OPENING_EQUITY_ACCOUNT,
  openingBalanceEntry,
  payableEntry,
  paymentEntry,
  trialBalance,
  type JournalEntry,
} from "../lib/accounting";

const DATE = "2026-08-27";

function lineOf(entry: JournalEntry, code: string) {
  return entry.lines.find((line) => line.accountCode === code);
}

describe("دليل الحسابات", () => {
  it("لا يحمل رمزًا مكررًا", () => {
    const codes = ACCOUNTS.map((account) => account.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("كل حساب فرعي له أب موجود", () => {
    for (const account of ACCOUNTS) {
      if (!account.parent) continue;
      expect(ACCOUNTS.some((other) => other.code === account.parent)).toBe(true);
    }
  });
});

describe("قيود المستندات", () => {
  it("الفاتورة: مدين الذمم بالصافي والخصم، دائن الإيراد بالإجمالي", () => {
    const entry = invoiceEntry({
      invoiceNumber: "INV-1", date: DATE, patientName: "عبدالله",
      totalMinor: 100000, discountMinor: 20000, cancelled: false,
    })!;
    expect(lineOf(entry, AR_ACCOUNT)).toEqual({ accountCode: AR_ACCOUNT, amountMinor: 80000, side: "debit" });
    expect(lineOf(entry, DISCOUNT_ACCOUNT)?.amountMinor).toBe(20000);
    expect(lineOf(entry, REVENUE_ACCOUNT)?.amountMinor).toBe(100000);
    expect(isBalanced(entry)).toBe(true);
  });

  it("الفاتورة الملغاة لا تُنتج قيدًا", () => {
    expect(invoiceEntry({
      invoiceNumber: "INV-2", date: DATE, patientName: "س",
      totalMinor: 100000, discountMinor: 0, cancelled: true,
    })).toBeNull();
  });

  it("الدفعة: مدين الصندوق دائن الذمم — والاسترداد يعكسهما", () => {
    const payment = paymentEntry({
      receiptNumber: "R-1", date: DATE, patientName: "عبدالله",
      currency: "USD", baseAmountMinor: 54500, kind: "payment",
    })!;
    expect(lineOf(payment, CASH_ACCOUNT.USD)?.side).toBe("debit");
    expect(lineOf(payment, AR_ACCOUNT)?.side).toBe("credit");

    const refund = paymentEntry({
      receiptNumber: "R-2", date: DATE, patientName: "عبدالله",
      currency: "USD", baseAmountMinor: 54500, kind: "refund",
    })!;
    // الدفاتر لا تُمحى، تُعكَس.
    expect(lineOf(refund, CASH_ACCOUNT.USD)?.side).toBe("credit");
    expect(lineOf(refund, AR_ACCOUNT)?.side).toBe("debit");
    expect(isBalanced(refund)).toBe(true);
  });

  it("الالتزام يُثبت المصروف يوم نشأ لا يوم دُفع", () => {
    const entry = payableEntry({
      reference: "PB-1", date: DATE, partyName: "مختبر النور",
      category: "lab", baseAmountMinor: 25000,
    })!;
    expect(lineOf(entry, "5101")?.side).toBe("debit");
    expect(lineOf(entry, AP_ACCOUNT)?.side).toBe("credit");
  });

  it("سداد جهة مسجّلة يُنقص الذمم لا يُكرّر المصروف", () => {
    // لو قُيّد سداد المختبر مصروفًا لظهرت التكلفة مرتين: يوم الالتزام ويوم السداد.
    const settle = expenseEntry({
      voucherNumber: "V-1", date: DATE, payeeName: "مختبر النور", category: "lab",
      currency: "YER", baseAmountMinor: 25000, settlesPayable: true,
    })!;
    expect(lineOf(settle, AP_ACCOUNT)?.side).toBe("debit");
    expect(lineOf(settle, "5101")).toBeUndefined();

    const direct = expenseEntry({
      voucherNumber: "V-2", date: DATE, payeeName: "صيدلية", category: "materials",
      currency: "YER", baseAmountMinor: 8000, settlesPayable: false,
    })!;
    expect(lineOf(direct, "5201")?.side).toBe("debit");
  });

  it("فرق الجرد: النقص مصروف والزيادة تُقيَّد في الصندوق", () => {
    const shortage = cashDifferenceEntry({ shiftId: 1, date: DATE, currency: "YER", differenceMinor: -5000 })!;
    expect(lineOf(shortage, "5961")?.side).toBe("debit");
    expect(lineOf(shortage, CASH_ACCOUNT.YER)?.side).toBe("credit");

    const surplus = cashDifferenceEntry({ shiftId: 1, date: DATE, currency: "YER", differenceMinor: 3000 })!;
    expect(lineOf(surplus, CASH_ACCOUNT.YER)?.side).toBe("debit");

    expect(cashDifferenceEntry({ shiftId: 1, date: DATE, currency: "YER", differenceMinor: 0 })).toBeNull();
  });

  it("كل قيد يتوازن — وهو الفحص الذي يجعل النظام محاسبيًا", () => {
    const entries = [
      invoiceEntry({ invoiceNumber: "INV-1", date: DATE, patientName: "س", totalMinor: 100000, discountMinor: 20000, cancelled: false }),
      paymentEntry({ receiptNumber: "R-1", date: DATE, patientName: "س", currency: "SAR", baseAmountMinor: 28000, kind: "payment" }),
      payableEntry({ reference: "PB-1", date: DATE, partyName: "م", category: "lab", baseAmountMinor: 25000 }),
      expenseEntry({ voucherNumber: "V-1", date: DATE, payeeName: "م", category: "lab", currency: "YER", baseAmountMinor: 25000, settlesPayable: true }),
      cashDifferenceEntry({ shiftId: 1, date: DATE, currency: "YER", differenceMinor: -5000 }),
    ].filter(Boolean) as JournalEntry[];
    for (const entry of entries) expect(isBalanced(entry)).toBe(true);
  });
});

describe("القوائم المالية", () => {
  // سيناريو كامل: فاتورة 100,000 بخصم 20,000، تحصيل 50,000 نقدًا،
  // التزام مختبر 25,000، سداد منه 10,000، ومصروف مواد مباشر 8,000.
  const entries = [
    invoiceEntry({ invoiceNumber: "INV-1", date: DATE, patientName: "س", totalMinor: 100000, discountMinor: 20000, cancelled: false }),
    paymentEntry({ receiptNumber: "R-1", date: DATE, patientName: "س", currency: "YER", baseAmountMinor: 50000, kind: "payment" }),
    payableEntry({ reference: "PB-1", date: DATE, partyName: "م", category: "lab", baseAmountMinor: 25000 }),
    expenseEntry({ voucherNumber: "V-1", date: DATE, payeeName: "م", category: "lab", currency: "YER", baseAmountMinor: 10000, settlesPayable: true }),
    expenseEntry({ voucherNumber: "V-2", date: DATE, payeeName: "ص", category: "materials", currency: "YER", baseAmountMinor: 8000, settlesPayable: false }),
  ].filter(Boolean) as JournalEntry[];

  const balances = trialBalance(entries);

  it("ميزان المراجعة يتوازن: مجموع المدين = مجموع الدائن", () => {
    const debit = balances.reduce((sum, row) => sum + row.debitMinor, 0);
    const credit = balances.reduce((sum, row) => sum + row.creditMinor, 0);
    expect(debit).toBe(credit);
  });

  it("أرصدة الحسابات بطبيعتها", () => {
    const by = (code: string) => balances.find((row) => row.code === code)?.balanceMinor ?? 0;
    expect(by(AR_ACCOUNT)).toBe(30000);            // 80,000 مفوتر − 50,000 محصّل
    expect(by(CASH_ACCOUNT.YER)).toBe(32000);      // 50,000 − 10,000 − 8,000
    expect(by(AP_ACCOUNT)).toBe(15000);            // 25,000 − 10,000
    expect(by(REVENUE_ACCOUNT)).toBe(100000);
  });

  it("قائمة الدخل على أساس الاستحقاق: الإيراد من الفواتير والمصروف من الالتزامات", () => {
    const statement = incomeStatement(balances);
    expect(statement.revenueMinor).toBe(100000);
    expect(statement.discountMinor).toBe(20000);
    expect(statement.netRevenueMinor).toBe(80000);
    // المصروف 25,000 مختبر (يوم الالتزام لا يوم السداد) + 8,000 مواد.
    expect(statement.totalExpensesMinor).toBe(33000);
    expect(statement.netProfitMinor).toBe(47000);
  });

  it("الميزانية تتوازن: الأصول = الخصوم + حقوق الملكية", () => {
    const sheet = balanceSheet(balances);
    expect(sheet.totalAssetsMinor).toBe(62000);      // 32,000 نقد + 30,000 ذمم
    expect(sheet.totalLiabilitiesMinor).toBe(15000); // ذمم موردين
    expect(sheet.equityMinor).toBe(47000);           // الربح
    expect(sheet.differenceMinor).toBe(0);
  });

  it("يقيّد الرصيد الافتتاحي أصلًا مقابل حقوق الملكية لا إيرادًا", () => {
    // الطريقة السهلة أن يُفتح للمريض «فاتورة سابقة»، فيدخل دَينٌ عمره سنتان في
    // إيراد هذا الشهر: أرباح لم تتحقق، وعمولات عن عمل قديم دُفعت عمولته أصلًا.
    const entry = openingBalanceEntry({
      patientId: 7, date: DATE, patientName: "سعيد", amountMinor: 120000,
    });
    expect(entry).not.toBeNull();
    expect(isBalanced(entry!)).toBe(true);
    expect(entry!.lines).toContainEqual({
      accountCode: AR_ACCOUNT, amountMinor: 120000, side: "debit",
    });
    expect(entry!.lines).toContainEqual({
      accountCode: OPENING_EQUITY_ACCOUNT, amountMinor: 120000, side: "credit",
    });
    // لا يمسّ الإيراد بشيء.
    expect(entry!.lines.some((line) => line.accountCode === REVENUE_ACCOUNT)).toBe(false);

    const statement = incomeStatement(trialBalance([entry!]));
    expect(statement.revenueMinor).toBe(0);
    expect(statement.netProfitMinor).toBe(0);

    const sheet = balanceSheet(trialBalance([entry!]));
    expect(sheet.totalAssetsMinor).toBe(120000);
    expect(sheet.differenceMinor).toBe(0);
  });

  it("يرفض الرصيد الافتتاحي غير الموجب", () => {
    expect(openingBalanceEntry({
      patientId: 7, date: DATE, patientName: "سعيد", amountMinor: 0,
    })).toBeNull();
  });

  it("تظل متوازنة بعد قيد رصيد افتتاحي", () => {
    // الرصيد الافتتاحي كان يُقيَّد في الدفاتر ولا يظهر في الميزانية، فتبدو غير
    // متوازنة بمقدار رأس المال بالضبط — خللٌ في القراءة يبدو خللًا في النظام.
    const withCapital = trialBalance([
      ...entries,
      {
        source: "manual", reference: "JM-1", date: DATE, description: "رصيد افتتاحي",
        lines: [
          { accountCode: CASH_ACCOUNT.YER, amountMinor: 200000, side: "debit" as const },
          { accountCode: "3101", amountMinor: 200000, side: "credit" as const },
        ],
      },
    ]);
    const sheet = balanceSheet(withCapital);
    expect(sheet.capitalMinor).toBe(200000);
    expect(sheet.totalAssetsMinor).toBe(262000);
    expect(sheet.equityMinor).toBe(247000);
    expect(sheet.differenceMinor).toBe(0);
  });
});
