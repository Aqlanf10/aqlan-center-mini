import { describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  AP_ACCOUNT,
  AR_ACCOUNT,
  CASH_ACCOUNT,
  CURRENCY_CLEARING_ACCOUNT,
  DISCOUNT_ACCOUNT,
  REVENUE_ACCOUNT,
  balanceOf,
  balanceSheet,
  cashDifferenceEntry,
  expenseEntry,
  incomeStatement,
  invoiceEntry,
  isBalanced,
  OPENING_EQUITY_ACCOUNT,
  openingBalanceEntry,
  openingPayableEntry,
  payableEntry,
  paymentEntry,
  statementsByCurrency,
  trialBalance,
  type JournalEntry,
} from "../lib/accounting";

const DATE = "2026-08-27";

function lineOf(entry: JournalEntry, code: string, currency?: string) {
  return entry.lines.find((line) => line.accountCode === code && (currency === undefined || line.currency === currency));
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

  it("(TD-REG-028) حساب مقاصة تحويل العملات أصلٌ وسيط مستقل عن فروقات الصرف", () => {
    const clearing = ACCOUNTS.find((account) => account.code === CURRENCY_CLEARING_ACCOUNT);
    expect(clearing).toMatchObject({ kind: "asset", parent: "19" });
  });
});

describe("قيود المستندات — كل سطرٍ بعملته", () => {
  it("الفاتورة: مدين الذمم بالصافي والخصم، دائن الإيراد بالإجمالي — بعملة الفاتورة", () => {
    const entry = invoiceEntry({
      invoiceNumber: "INV-1", date: DATE, patientName: "عبدالله", currency: "SAR",
      totalMinor: 100000, discountMinor: 20000, cancelled: false,
    })!;
    expect(lineOf(entry, AR_ACCOUNT)).toEqual({ accountCode: AR_ACCOUNT, currency: "SAR", amountMinor: 80000, side: "debit" });
    expect(lineOf(entry, DISCOUNT_ACCOUNT)).toMatchObject({ currency: "SAR", amountMinor: 20000 });
    expect(lineOf(entry, REVENUE_ACCOUNT)).toMatchObject({ currency: "SAR", amountMinor: 100000 });
    expect(entry.lines.every((line) => line.currency === "SAR")).toBe(true);
    expect(isBalanced(entry)).toBe(true);
  });

  it("الفاتورة الملغاة لا تُنتج قيدًا", () => {
    expect(invoiceEntry({
      invoiceNumber: "INV-2", date: DATE, patientName: "س", currency: "YER",
      totalMinor: 100000, discountMinor: 0, cancelled: true,
    })).toBeNull();
  });

  it("الدفعة بعملة هدفها: مدين الصندوق دائن الذمم بالعملة نفسها — والاسترداد يعكسهما", () => {
    const payment = paymentEntry({
      receiptNumber: "R-1", date: DATE, patientName: "عبدالله",
      currency: "USD", amountMinor: 10000, settlementCurrency: "USD", settlementMinor: 10000, kind: "payment",
    })!;
    expect(lineOf(payment, CASH_ACCOUNT.USD)).toMatchObject({ currency: "USD", amountMinor: 10000, side: "debit" });
    expect(lineOf(payment, AR_ACCOUNT)).toMatchObject({ currency: "USD", amountMinor: 10000, side: "credit" });
    expect(lineOf(payment, CURRENCY_CLEARING_ACCOUNT)).toBeUndefined();

    const refund = paymentEntry({
      receiptNumber: "R-2", date: DATE, patientName: "عبدالله",
      currency: "USD", amountMinor: 10000, settlementCurrency: "USD", settlementMinor: 10000, kind: "refund",
    })!;
    // الدفاتر لا تُمحى، تُعكَس.
    expect(lineOf(refund, CASH_ACCOUNT.USD)?.side).toBe("credit");
    expect(lineOf(refund, AR_ACCOUNT)?.side).toBe("debit");
    expect(isBalanced(refund)).toBe(true);
  });

  it("الدفعة العابرة للعملات تمرّ بالمقاصة برجلين مسجَّلين — وكل عملة تتوازن وحدها", () => {
    // 400.00 ر.س تسدّد فاتورة يمنية بمكافئها المسجَّل 56,000 ر.ي.
    const entry = paymentEntry({
      receiptNumber: "R-3", date: DATE, patientName: "س",
      currency: "SAR", amountMinor: 40000, settlementCurrency: "YER", settlementMinor: 56000, kind: "payment",
    })!;
    expect(entry.lines).toEqual(expect.arrayContaining([
      { accountCode: CASH_ACCOUNT.SAR, currency: "SAR", amountMinor: 40000, side: "debit" },
      { accountCode: CURRENCY_CLEARING_ACCOUNT, currency: "SAR", amountMinor: 40000, side: "credit" },
      { accountCode: CURRENCY_CLEARING_ACCOUNT, currency: "YER", amountMinor: 56000, side: "debit" },
      { accountCode: AR_ACCOUNT, currency: "YER", amountMinor: 56000, side: "credit" },
    ]));
    expect(entry.lines).toHaveLength(4);
    expect(isBalanced(entry)).toBe(true);
  });

  it("المُنشئ يقيّد التسوية الأجنبية→الأجنبية صحيحًا إن وُجد مبلغها المسجَّل (مسار الإنشاء يرفضها اليوم — TD-05)", () => {
    // ريالٌ يمني يسدّد فاتورة دولارية بمبلغٍ مسجَّل 200.00 $ — الدفتر جاهز لها دون سعرٍ مخمَّن.
    const entry = paymentEntry({
      receiptNumber: "R-4", date: DATE, patientName: "س",
      currency: "YER", amountMinor: 106000, settlementCurrency: "USD", settlementMinor: 20000, kind: "payment",
    })!;
    expect(isBalanced(entry)).toBe(true);
    expect(lineOf(entry, AR_ACCOUNT, "USD")).toMatchObject({ amountMinor: 20000, side: "credit" });
    expect(lineOf(entry, CASH_ACCOUNT.YER, "YER")).toMatchObject({ amountMinor: 106000, side: "debit" });
  });

  it("الالتزام يُثبت المصروف يوم نشأ لا يوم دُفع — بعملة الالتزام", () => {
    const entry = payableEntry({
      reference: "PB-1", date: DATE, partyName: "مختبر النور",
      category: "lab", currency: "USD", amountMinor: 25000,
    })!;
    expect(lineOf(entry, "5101")).toMatchObject({ currency: "USD", side: "debit" });
    expect(lineOf(entry, AP_ACCOUNT)).toMatchObject({ currency: "USD", side: "credit" });
  });

  it("سداد جهة مسجّلة يُنقص الذمم لا يُكرّر المصروف", () => {
    // لو قُيّد سداد المختبر مصروفًا لظهرت التكلفة مرتين: يوم الالتزام ويوم السداد.
    const settle = expenseEntry({
      voucherNumber: "V-1", date: DATE, payeeName: "مختبر النور", category: "lab",
      currency: "YER", amountMinor: 25000, settlesPayable: true,
      settlements: [{ paidMinor: 25000, payableCurrency: "YER", settledMinor: 25000 }],
    })!;
    expect(lineOf(settle, AP_ACCOUNT)).toMatchObject({ currency: "YER", side: "debit", amountMinor: 25000 });
    expect(lineOf(settle, "5101")).toBeUndefined();

    const direct = expenseEntry({
      voucherNumber: "V-2", date: DATE, payeeName: "صيدلية", category: "materials",
      currency: "YER", amountMinor: 8000, settlesPayable: false,
    })!;
    expect(lineOf(direct, "5201")?.side).toBe("debit");
  });

  it("سندٌ يمني يسدّد التزامًا دولاريًا بلقطته: الذمم الدولارية تنقص بالمسوّى والصندوق اليمني بالمدفوع", () => {
    const entry = expenseEntry({
      voucherNumber: "V-3", date: DATE, payeeName: "مورد", category: "supplier",
      currency: "YER", amountMinor: 106000, settlesPayable: true,
      settlements: [{ paidMinor: 106000, payableCurrency: "USD", settledMinor: 20000 }],
    })!;
    expect(entry.lines).toEqual(expect.arrayContaining([
      { accountCode: CASH_ACCOUNT.YER, currency: "YER", amountMinor: 106000, side: "credit" },
      { accountCode: CURRENCY_CLEARING_ACCOUNT, currency: "YER", amountMinor: 106000, side: "debit" },
      { accountCode: CURRENCY_CLEARING_ACCOUNT, currency: "USD", amountMinor: 20000, side: "credit" },
      { accountCode: AP_ACCOUNT, currency: "USD", amountMinor: 20000, side: "debit" },
    ]));
    expect(isBalanced(entry)).toBe(true);
  });

  it("التسوية المجمّعة: كل التزامٍ بعملته، والباقي غير الموزَّع دفعة مقدّمة بعملة السند", () => {
    const entry = expenseEntry({
      voucherNumber: "V-4", date: DATE, payeeName: "مختبر", category: "lab",
      currency: "YER", amountMinor: 100000, settlesPayable: true,
      settlements: [
        { paidMinor: 60000, payableCurrency: "YER", settledMinor: 60000 },
        { paidMinor: 26500, payableCurrency: "USD", settledMinor: 5000 },
      ],
    })!;
    expect(isBalanced(entry)).toBe(true);
    const ap = entry.lines.filter((line) => line.accountCode === AP_ACCOUNT);
    expect(ap).toEqual(expect.arrayContaining([
      { accountCode: AP_ACCOUNT, currency: "YER", amountMinor: 60000, side: "debit" },
      { accountCode: AP_ACCOUNT, currency: "USD", amountMinor: 5000, side: "debit" },
      { accountCode: AP_ACCOUNT, currency: "YER", amountMinor: 13500, side: "debit" },
    ]));
  });

  it("(L-03) سند الإبطال بمبالغ سالبة مرآة الأصل بالضبط — لا يُسقط من الدفاتر", () => {
    const original = expenseEntry({
      voucherNumber: "V-5", date: DATE, payeeName: "مورد", category: "supplier",
      currency: "YER", amountMinor: 106000, settlesPayable: true,
      settlements: [{ paidMinor: 106000, payableCurrency: "USD", settledMinor: 20000 }],
    })!;
    const reversal = expenseEntry({
      voucherNumber: "X-5", date: DATE, payeeName: "مورد", category: "supplier",
      currency: "YER", amountMinor: -106000, settlesPayable: true,
      settlements: [{ paidMinor: -106000, payableCurrency: "USD", settledMinor: -20000 }],
    })!;
    expect(reversal).not.toBeNull();
    expect(reversal.source).toBe("expense_void");
    expect(isBalanced(reversal)).toBe(true);
    const net = trialBalance([original, reversal]);
    expect(net.every((row) => row.balanceMinor === 0)).toBe(true);

    const directVoid = expenseEntry({
      voucherNumber: "X-6", date: DATE, payeeName: "كهرباء", category: "electricity",
      currency: "YER", amountMinor: -5000, settlesPayable: false,
    })!;
    expect(lineOf(directVoid, "5502")).toMatchObject({ side: "credit", amountMinor: 5000 });
    expect(lineOf(directVoid, CASH_ACCOUNT.YER)).toMatchObject({ side: "debit", amountMinor: 5000 });
  });

  it("فرق الجرد بعملة الدرج: النقص مصروف والزيادة تُقيَّد في الصندوق — بلا سعر", () => {
    const shortage = cashDifferenceEntry({ shiftId: 1, date: DATE, currency: "USD", differenceMinor: -1000 })!;
    expect(lineOf(shortage, "5961")).toMatchObject({ currency: "USD", side: "debit", amountMinor: 1000 });
    expect(lineOf(shortage, CASH_ACCOUNT.USD)).toMatchObject({ currency: "USD", side: "credit" });

    const surplus = cashDifferenceEntry({ shiftId: 1, date: DATE, currency: "YER", differenceMinor: 3000 })!;
    expect(lineOf(surplus, CASH_ACCOUNT.YER)?.side).toBe("debit");

    expect(cashDifferenceEntry({ shiftId: 1, date: DATE, currency: "YER", differenceMinor: 0 })).toBeNull();
  });

  it("(TD-REG-028) التوازن داخل كل عملة: 100 ر.س مقابل 100 ر.ي متساويان رقمًا ومرفوضان", () => {
    const mixed: JournalEntry = {
      source: "manual", reference: "", date: DATE, description: "ممزوج",
      lines: [
        { accountCode: CASH_ACCOUNT.SAR, currency: "SAR", amountMinor: 10000, side: "debit" },
        { accountCode: REVENUE_ACCOUNT, currency: "YER", amountMinor: 10000, side: "credit" },
      ],
    };
    expect(isBalanced(mixed)).toBe(false);
    const unknown = { ...mixed, lines: mixed.lines.map((line) => ({ ...line, currency: "EUR" as never })) };
    expect(isBalanced(unknown)).toBe(false);
  });

  it("كل قيد يتوازن — وهو الفحص الذي يجعل النظام محاسبيًا", () => {
    const entries = [
      invoiceEntry({ invoiceNumber: "INV-1", date: DATE, patientName: "س", currency: "YER", totalMinor: 100000, discountMinor: 20000, cancelled: false }),
      paymentEntry({ receiptNumber: "R-1", date: DATE, patientName: "س", currency: "SAR", amountMinor: 20000, settlementCurrency: "YER", settlementMinor: 28000, kind: "payment" }),
      payableEntry({ reference: "PB-1", date: DATE, partyName: "م", category: "lab", currency: "YER", amountMinor: 25000 }),
      expenseEntry({ voucherNumber: "V-1", date: DATE, payeeName: "م", category: "lab", currency: "YER", amountMinor: 25000, settlesPayable: true, settlements: [{ paidMinor: 25000, payableCurrency: "YER", settledMinor: 25000 }] }),
      cashDifferenceEntry({ shiftId: 1, date: DATE, currency: "YER", differenceMinor: -5000 }),
      openingPayableEntry({ payableId: 1, date: DATE, partyName: "م", currency: "USD", amountMinor: 50000 }),
    ].filter(Boolean) as JournalEntry[];
    for (const entry of entries) expect(isBalanced(entry)).toBe(true);
  });
});

describe("القوائم المالية — لكل عملة", () => {
  // سيناريو كامل بالريال اليمني: فاتورة 100,000 بخصم 20,000، تحصيل 50,000 نقدًا،
  // التزام مختبر 25,000، سداد منه 10,000، ومصروف مواد مباشر 8,000.
  // وفاتورة سعودية 1,000.00 ر.س لا تمسّ أي رقمٍ يمني.
  const entries = [
    invoiceEntry({ invoiceNumber: "INV-1", date: DATE, patientName: "س", currency: "YER", totalMinor: 100000, discountMinor: 20000, cancelled: false }),
    paymentEntry({ receiptNumber: "R-1", date: DATE, patientName: "س", currency: "YER", amountMinor: 50000, settlementCurrency: "YER", settlementMinor: 50000, kind: "payment" }),
    payableEntry({ reference: "PB-1", date: DATE, partyName: "م", category: "lab", currency: "YER", amountMinor: 25000 }),
    expenseEntry({ voucherNumber: "V-1", date: DATE, payeeName: "م", category: "lab", currency: "YER", amountMinor: 10000, settlesPayable: true, settlements: [{ paidMinor: 10000, payableCurrency: "YER", settledMinor: 10000 }] }),
    expenseEntry({ voucherNumber: "V-2", date: DATE, payeeName: "ص", category: "materials", currency: "YER", amountMinor: 8000, settlesPayable: false }),
    invoiceEntry({ invoiceNumber: "INV-S", date: DATE, patientName: "ع", currency: "SAR", totalMinor: 100000, discountMinor: 0, cancelled: false }),
  ].filter(Boolean) as JournalEntry[];

  const balances = trialBalance(entries);

  it("ميزان المراجعة صفٌّ لكل (حساب، عملة) ويتوازن داخل كل عملة", () => {
    for (const currency of ["YER", "SAR"] as const) {
      const rows = balances.filter((row) => row.currency === currency);
      const debit = rows.reduce((sum, row) => sum + row.debitMinor, 0);
      const credit = rows.reduce((sum, row) => sum + row.creditMinor, 0);
      expect(debit).toBe(credit);
    }
    expect(balances.filter((row) => row.code === AR_ACCOUNT).map((row) => row.currency)).toEqual(["YER", "SAR"]);
  });

  it("أرصدة الحسابات بطبيعتها — كلٌّ بعملته", () => {
    expect(balanceOf(balances, AR_ACCOUNT, "YER")).toBe(30000);        // 80,000 مفوتر − 50,000 محصّل
    expect(balanceOf(balances, AR_ACCOUNT, "SAR")).toBe(100000);       // 1,000.00 ر.س — لا يُجمع مع اليمني
    expect(balanceOf(balances, CASH_ACCOUNT.YER, "YER")).toBe(32000);  // 50,000 − 10,000 − 8,000
    expect(balanceOf(balances, AP_ACCOUNT, "YER")).toBe(15000);        // 25,000 − 10,000
    expect(balanceOf(balances, REVENUE_ACCOUNT, "YER")).toBe(100000);
  });

  it("قائمة الدخل على أساس الاستحقاق — لكل عملة وحدها", () => {
    const statement = incomeStatement(balances, "YER");
    expect(statement.currency).toBe("YER");
    expect(statement.revenueMinor).toBe(100000);
    expect(statement.discountMinor).toBe(20000);
    expect(statement.netRevenueMinor).toBe(80000);
    // المصروف 25,000 مختبر (يوم الالتزام لا يوم السداد) + 8,000 مواد.
    expect(statement.totalExpensesMinor).toBe(33000);
    expect(statement.netProfitMinor).toBe(47000);

    const sar = incomeStatement(balances, "SAR");
    expect(sar).toMatchObject({ revenueMinor: 100000, totalExpensesMinor: 0, netProfitMinor: 100000 });
  });

  it("الميزانية تتوازن داخل كل عملة: الأصول = الخصوم + حقوق الملكية", () => {
    const sheet = balanceSheet(balances, "YER");
    expect(sheet.totalAssetsMinor).toBe(62000);      // 32,000 نقد + 30,000 ذمم
    expect(sheet.totalLiabilitiesMinor).toBe(15000); // ذمم موردين
    expect(sheet.equityMinor).toBe(47000);           // الربح
    expect(sheet.differenceMinor).toBe(0);
    expect(balanceSheet(balances, "SAR").differenceMinor).toBe(0);
    expect(statementsByCurrency(balances).map((item) => item.currency)).toEqual(["YER", "SAR"]);
  });

  it("يقيّد الرصيد الافتتاحي أصلًا مقابل حقوق الملكية لا إيرادًا — بعملته (F-06)", () => {
    // الطريقة السهلة أن يُفتح للمريض «فاتورة سابقة»، فيدخل دَينٌ عمره سنتان في
    // إيراد هذا الشهر: أرباح لم تتحقق، وعمولات عن عمل قديم دُفعت عمولته أصلًا.
    const entry = openingBalanceEntry({
      patientId: 7, date: DATE, patientName: "سعيد", currency: "SAR", amountMinor: 120000,
    });
    expect(entry).not.toBeNull();
    expect(isBalanced(entry!)).toBe(true);
    expect(entry!.lines).toContainEqual({ accountCode: AR_ACCOUNT, currency: "SAR", amountMinor: 120000, side: "debit" });
    expect(entry!.lines).toContainEqual({ accountCode: OPENING_EQUITY_ACCOUNT, currency: "SAR", amountMinor: 120000, side: "credit" });
    // لا يمسّ الإيراد بشيء.
    expect(entry!.lines.some((line) => line.accountCode === REVENUE_ACCOUNT)).toBe(false);

    const statement = incomeStatement(trialBalance([entry!]), "SAR");
    expect(statement.revenueMinor).toBe(0);
    expect(statement.netProfitMinor).toBe(0);

    const sheet = balanceSheet(trialBalance([entry!]), "SAR");
    expect(sheet.totalAssetsMinor).toBe(120000);
    expect(sheet.differenceMinor).toBe(0);
  });

  it("يرفض الرصيد الافتتاحي غير الموجب", () => {
    expect(openingBalanceEntry({
      patientId: 7, date: DATE, patientName: "سعيد", currency: "YER", amountMinor: 0,
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
          { accountCode: CASH_ACCOUNT.YER, currency: "YER", amountMinor: 200000, side: "debit" as const },
          { accountCode: "3101", currency: "YER", amountMinor: 200000, side: "credit" as const },
        ],
      },
    ]);
    const sheet = balanceSheet(withCapital, "YER");
    expect(sheet.capitalMinor).toBe(200000);
    expect(sheet.totalAssetsMinor).toBe(262000);
    expect(sheet.equityMinor).toBe(247000);
    expect(sheet.differenceMinor).toBe(0);
  });
});
