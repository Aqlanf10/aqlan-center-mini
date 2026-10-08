import type { DailyClinicReport, DailyCurrencyAmounts } from "../../lib/daily-clinic-report-types";

const zero = (): DailyCurrencyAmounts => ({ YER: 0, SAR: 0, USD: 0 });
const agreement = (): DailyCurrencyAmounts => ({ YER: 987654321, SAR: 23456789, USD: 34567890 });
const paid = (): DailyCurrencyAmounts => ({ YER: 123456, SAR: 456789, USD: 567890 });
const remaining = (): DailyCurrencyAmounts => ({ YER: 987530865, SAR: 23000000, USD: 34000000 });
const multiplied = (amounts: DailyCurrencyAmounts, n: number): DailyCurrencyAmounts => ({ YER: amounts.YER * n, SAR: amounts.SAR * n, USD: amounts.USD * n });
const expenseTotals = () => ({ outflowMinor: { YER: 10000, SAR: 0, USD: 0 }, reversalMinor: { YER: 2000, SAR: 0, USD: 0 }, netOutflowMinor: { YER: 8000, SAR: 0, USD: 0 }, voucherCount: 2, reversalCount: 1, negativeAdjustmentCount: 0 });

/** Entirely synthetic, deterministic and independent of application records. */
export function dailyClinicReportFixture(date = "2026-09-30", count = 2): DailyClinicReport {
  const recipient = { key: "party:700", partyId: 700, partyKind: "supplier", currentPartyName: "مستفيد اصطناعي طويل الاسم", recordedPayeeText: "SYNTHETIC-PAYEE", displayName: "مستفيد اصطناعي طويل الاسم", nameSource: "current_party" as const };
  return {
    date, clinicTimeZone: "Asia/Aden", generatedAt: "2026-10-02T08:00:00.000Z", selectedDayCutoff: `${date}T21:00:00.000Z`,
    basis: { cohort: "arrival_day", account: "current_at_generation", work: "signed_by_cutoff", receipts: "clinicwide_recorded_day" },
    attendees: Array.from({ length: count }, (_, index) => ({
      key: `patient:${index + 1}`, patientId: index + 1, patientNumber: `SYNTHETIC-${String(index + 1).padStart(4, "0")}`,
      patientName: `مراجع اصطناعي طويل الاسم ${index + 1}`, visitIds: [index * 2 + 1, index * 2 + 2], visitsCount: 2,
      signedVisitsCount: 1, pendingVisitsCount: 1, lateSignedVisitsCount: 0,
      workSummary: "متابعة تقويم مشمولة مع إجراء موثّق طويل الوصف بلا توزيع تخميني لمبلغ الاتفاق",
      agreementIds: [1000 + index * 3, 1001 + index * 3, 1002 + index * 3], agreement: agreement(), explicitlySettled: paid(), agreementRemaining: remaining(), excludedAgreementCount: 0,
    })),
    agreements: Array.from({ length: count }, (_, index) => (["YER", "SAR", "USD"] as const).map((currency, offset) => ({
      id: 1000 + index * 3 + offset, patientId: index + 1, patientName: `مراجع اصطناعي ${index + 1}`, title: `اتفاق اصطناعي ${currency}`, status: "active", consentAt: "2026-09-01T08:00:00.000Z", currency, principalMinor: agreement()[currency], explicitlySettledMinor: paid()[currency], remainingMinor: remaining()[currency], excessSettlementMinor: 0, includedInTotals: true, excludedReason: null, linkedVisitIds: [index * 2 + 1, index * 2 + 2], paymentIds: [],
    }))).flat(),
    work: count === 0 ? [] : [{ key: "procedure:100", patientKey: "patient:1", patientName: "مراجع اصطناعي 1", visitId: 1, sourceType: "procedure", sourceId: 100, signedAt: `${date}T09:00:00.000Z`, description: "عمل سريري اصطناعي مشمول", quantity: 1, toothCode: 11, doctorName: "طبيب اصطناعي", agreementId: 1000, classification: "included", valueMinor: null, currency: null, valuationBasis: null, unvaluedReason: "جلسة جزئية مشمولة لا تُوزّع عليها قيمة الاتفاق" }],
    currentAccounts: count === 0 ? [] : [{ patientId: 1, patientName: "مراجع اصطناعي 1", byCurrency: { YER: { openingMinor: 100, billedMinor: 10000, collectedMinor: 2000, receivableMinor: 8100, creditMinor: 0 }, SAR: { openingMinor: 0, billedMinor: 0, collectedMinor: 45000, receivableMinor: 0, creditMinor: 45000 }, USD: { openingMinor: 0, billedMinor: 0, collectedMinor: 0, receivableMinor: 0, creditMinor: 0 } }, unallocatedPaymentIds: [501] }],
    receipts: [
      { id: 500, receiptNumber: "SYNTHETIC-RECEIPT-500", patientId: 1, patientName: "مراجع اصطناعي 1", attendee: count > 0, at: `${date}T09:30:00.000Z`, kind: "payment", reversalOfId: null, tenderCurrency: "USD", tenderMinor: 10000, method: "cash", invoiceId: null, planId: 1000, openingCurrency: null, settlementCurrency: "YER", signedSettlementMinor: 53000, recordedBaseMinor: 53000, exchangeRate: 530 },
      { id: 501, receiptNumber: "SYNTHETIC-NONATTENDEE-501", patientId: 6000, patientName: "شخص اصطناعي لم يحضر", attendee: false, at: `${date}T11:00:00.000Z`, kind: "refund", reversalOfId: 499, tenderCurrency: "SAR", tenderMinor: 2500, method: "transfer", invoiceId: null, planId: null, openingCurrency: "SAR", settlementCurrency: "SAR", signedSettlementMinor: -2500, recordedBaseMinor: 3500, exchangeRate: 140 },
    ],
    invoices: count === 0 ? [] : [
      { id: 900, invoiceNumber: "SYNTHETIC-INV-900", patientId: 1, patientName: "مراجع اصطناعي 1", status: "open", currency: "YER", totalMinor: 150000, discountMinor: 0, netMinor: 150000, originalNetMinor: 150000, excessSettledMinor: 0,
        issuedAt: `${date}T08:30:00.000Z`, issuedClinicDate: date, issuedOnReportDay: true, reasons: ["issued_today", "receipt_today"], linkage: "single_case",
        lines: [{ id: 9001, description: "علاج عصب اصطناعي — سن 36", totalMinor: 150000, planItemId: 3001, planId: 1000, caseId: 4001, toothCode: 36 }],
        explicitPaymentIds: [502], explicitlySettledMinor: 50000, remainingMinor: 100000, corrections: [], correctsInvoiceNumbers: ["SYNTHETIC-INV-899"] },
      { id: 901, invoiceNumber: "SYNTHETIC-INV-901", patientId: 1, patientName: "مراجع اصطناعي 1", status: "open", currency: "SAR", totalMinor: 90000, discountMinor: 5000, netMinor: 85000, originalNetMinor: 85000, excessSettledMinor: 0,
        issuedAt: `${date}T09:10:00.000Z`, issuedClinicDate: date, issuedOnReportDay: true, reasons: ["issued_today"], linkage: "mixed",
        lines: [
          { id: 9011, description: "تاج اصطناعي — سن 14", totalMinor: 60000, planItemId: 3002, planId: 1001, caseId: 4002, toothCode: 14 },
          { id: 9012, description: "استشارة مالية فقط", totalMinor: 30000, planItemId: null, planId: null, caseId: null, toothCode: null },
        ],
        explicitPaymentIds: [], explicitlySettledMinor: 0, remainingMinor: 85000, corrections: [], correctsInvoiceNumbers: [] },
      { id: 899, invoiceNumber: "SYNTHETIC-INV-899", patientId: 1, patientName: "مراجع اصطناعي 1", status: "cancelled", currency: "YER", totalMinor: 180000, discountMinor: 0, netMinor: 0, originalNetMinor: 180000, excessSettledMinor: 0,
        issuedAt: `${date}T08:00:00.000Z`, issuedClinicDate: date, issuedOnReportDay: true, reasons: ["issued_today"], linkage: "single_plan_item",
        lines: [{ id: 8991, description: "علاج عصب اصطناعي — سن 36", totalMinor: 180000, planItemId: 3001, planId: 1000, caseId: 4001, toothCode: 36 }],
        explicitPaymentIds: [], explicitlySettledMinor: 0, remainingMinor: 0,
        corrections: [{ originalInvoiceId: 899, originalInvoiceNumber: "SYNTHETIC-INV-899", correctedInvoiceNumber: "SYNTHETIC-INV-900", reason: "تصحيح سعر اصطناعي", at: `${date}T08:29:00.000Z`, actor: "SYNTHETIC-ADMIN" }],
        correctsInvoiceNumbers: [] },
    ],
    legacyAgreements: count === 0 ? [] : [
      { id: 950, patientId: 2, patientName: "مراجع اصطناعي طويل الاسم 2", serviceName: "تقويم اصطناعي بدأ قبل النظام", specialty: "orthodontics", toothCode: null,
        coverageTeeth: [], coverageScope: "both", coverageRecorded: true, coverageState: "verified", coverageLabel: "الفكّان",
        openingEffect: "created", currentOpeningEffect: "in_opening", currency: "YER", agreedMinor: 300000, previouslyPaidMinor: 120000, remainingAtStartMinor: 180000,
        historicalAsOf: "2026-01-15", status: "live", voidReason: null, planItemId: 3100, caseId: 4100 },
      { id: 951, patientId: 2, patientName: "مراجع اصطناعي طويل الاسم 2", serviceName: "جسر اصطناعي قديم", specialty: "prosthodontics", toothCode: 24,
        coverageTeeth: null, coverageScope: null, coverageRecorded: false, coverageState: "unknown", coverageLabel: null,
        openingEffect: "created", currentOpeningEffect: "in_opening", currency: "USD", agreedMinor: 50000, previouslyPaidMinor: 20000, remainingAtStartMinor: 30000,
        historicalAsOf: "2025-12-01", status: "live", voidReason: null, planItemId: 3101, caseId: null },
    ],
    expenses: { date, timeZone: "Asia/Aden", scope: "clinic_spending_vouchers", currency: "all", movements: [
      { id: 700, voucherNumber: "SYNTHETIC-EXPENSE-700", createdAt: `${date}T12:00:00.000Z`, clinicDate: date, clinicTime: "15:00", shiftId: 1, categoryKey: "custom", categoryLabel: "فئة اصطناعية", recipient, amountMinor: 10000, currency: "YER", kind: "outflow", reversalOfId: null, originalVoucherNumber: null, payableId: 800, payableSourceType: "operational", allocations: [{ payableId: 800, sourceType: "operational", paidMinor: 10000, payableCurrency: "YER", settledMinor: 10000 }], unallocatedMinor: 0, note: "غرض اصطناعي للسند", createdBy: "SYNTHETIC-CREATOR-NOT-RECIPIENT" },
      { id: 701, voucherNumber: "SYNTHETIC-REVERSAL-701", createdAt: `${date}T13:00:00.000Z`, clinicDate: date, clinicTime: "16:00", shiftId: 1, categoryKey: "custom", categoryLabel: "فئة اصطناعية", recipient, amountMinor: -2000, currency: "YER", kind: "reversal", reversalOfId: 700, originalVoucherNumber: "SYNTHETIC-EXPENSE-700", payableId: null, payableSourceType: null, allocations: [], unallocatedMinor: -2000, note: null, createdBy: "SYNTHETIC-CREATOR-NOT-RECIPIENT" },
    ], recipientTotals: [{ recipient, recordedPayeeTexts: ["SYNTHETIC-PAYEE"], totals: expenseTotals() }], totals: expenseTotals(), caveats: ["سندات مسجّلة، لا قائمة دخل على أساس الاستحقاق."] },
    totals: { attendeesCount: count, visitsCount: count * 2, signedVisitsCount: count, pendingVisitsCount: count, lateSignedVisitsCount: 0,
      agreement: multiplied(agreement(), count), explicitlySettled: multiplied(paid(), count), agreementRemaining: multiplied(remaining(), count), knownCompletedValue: zero(), unvaluedWorkCount: count > 0 ? 1 : 0,
      currentReceivable: { YER: count > 0 ? 8100 : 0, SAR: 0, USD: 0 }, currentCredit: { YER: 0, SAR: count > 0 ? 45000 : 0, USD: 0 },
      nativeReceipts: { YER: 0, SAR: 0, USD: 10000 }, nativeReversals: { YER: 0, SAR: 2500, USD: 0 }, nativeNetRecorded: { YER: 0, SAR: -2500, USD: 10000 }, nativeCashNetRecorded: { YER: 0, SAR: 0, USD: 10000 }, nativeTransferNetRecorded: { YER: 0, SAR: -2500, USD: 0 },
      invoicesIssuedNet: { YER: count > 0 ? 150000 : 0, SAR: count > 0 ? 85000 : 0, USD: 0 },
      invoicesIssuedCount: count > 0 ? 2 : 0, cancelledInvoicesCount: count > 0 ? 1 : 0,
    },
    warnings: ["القيم المالية الحالية قد تتغير بعد يوم الحضور المختار."],
  };
}

/** Representative synthetic day: eight single-visit patients, short work text,
 * one agreement each, modest native amounts and named collection/spending rows. */
export function dailyClinicNormalDayFixture(): DailyClinicReport {
  const report = dailyClinicReportFixture("2026-09-30", 8);
  const currencies = ["YER", "SAR", "USD"] as const;
  const principal = { YER: 30000, SAR: 25000, USD: 10000 };
  const settled = { YER: 10000, SAR: 10000, USD: 2500 };
  report.totals.agreement = zero(); report.totals.explicitlySettled = zero();
  report.totals.agreementRemaining = zero(); report.totals.knownCompletedValue = zero();
  report.agreements = []; report.work = []; report.currentAccounts = [];
  report.attendees.forEach((patient, index) => {
    const currency = currencies[index % currencies.length], suffix = String(index + 1).padStart(2, "0");
    const agreementId = 1000 + index, visitId = index + 1;
    patient.patientName = `مراجع تجريبي ${suffix}`; patient.patientNumber = `DAY-${suffix}`;
    patient.visitIds = [visitId]; patient.visitsCount = 1; patient.signedVisitsCount = 1; patient.pendingVisitsCount = 0;
    patient.agreementIds = [agreementId]; patient.agreement = zero(); patient.explicitlySettled = zero(); patient.agreementRemaining = zero();
    patient.agreement[currency] = principal[currency]; patient.explicitlySettled[currency] = settled[currency];
    patient.agreementRemaining[currency] = principal[currency] - settled[currency];
    patient.workSummary = index < 6 ? "حشوة ضوئية" : "متابعة تقويم";
    report.totals.agreement[currency] += principal[currency]; report.totals.explicitlySettled[currency] += settled[currency];
    report.totals.agreementRemaining[currency] += patient.agreementRemaining[currency];
    report.agreements.push({ id: agreementId, patientId: index + 1, patientName: patient.patientName,
      title: `PLAN-${suffix}`, status: "active", consentAt: "2026-09-01T08:00:00.000Z", currency,
      principalMinor: principal[currency], explicitlySettledMinor: settled[currency], remainingMinor: patient.agreementRemaining[currency],
      excessSettlementMinor: 0, includedInTotals: true, excludedReason: null, linkedVisitIds: [visitId], paymentIds: [] });
    report.work.push({ key: `procedure:${visitId}`, patientKey: patient.key, patientName: patient.patientName, visitId,
      sourceType: "procedure", sourceId: visitId, signedAt: "2026-09-30T09:00:00.000Z",
      description: `WORK-${suffix} ${patient.workSummary}`, quantity: 1, toothCode: index < 6 ? 11 + index : null,
      doctorName: "طبيب تجريبي", agreementId, classification: "included",
      valueMinor: index < 6 ? principal[currency] : null, currency,
      valuationBasis: index < 6 ? "completed_plan_item" : null,
      unvaluedReason: index < 6 ? null : "جلسة متابعة مشمولة دون قيمة مستقلة" });
    if (index < 6) report.totals.knownCompletedValue[currency] += principal[currency];
    const byCurrency = Object.fromEntries(currencies.map((code) => [code, { openingMinor: 0,
      billedMinor: code === currency ? principal[currency] : 0,
      collectedMinor: code === currency ? settled[currency] : 0,
      receivableMinor: code === currency ? principal[currency] - settled[currency] : 0, creditMinor: 0 }])) as DailyClinicReport["currentAccounts"][number]["byCurrency"];
    report.currentAccounts.push({ patientId: index + 1, patientName: patient.patientName, byCurrency, unallocatedPaymentIds: [] });
  });
  report.totals.visitsCount = 8; report.totals.signedVisitsCount = 8; report.totals.pendingVisitsCount = 0;
  report.totals.unvaluedWorkCount = 2; report.totals.currentReceivable = { ...report.totals.agreementRemaining }; report.totals.currentCredit = zero();
  const original = report.receipts[0];
  report.receipts = [
    { ...original, receiptNumber: "RECEIPT-01", patientName: report.attendees[0].patientName,
      tenderCurrency: "YER", tenderMinor: 10000, settlementCurrency: "YER", signedSettlementMinor: 10000, recordedBaseMinor: 10000, exchangeRate: 1 },
    { ...original, id: 502, receiptNumber: "RECEIPT-02", patientId: 2, patientName: report.attendees[1].patientName,
      planId: 1001, tenderCurrency: "SAR", tenderMinor: 10000, settlementCurrency: "SAR", signedSettlementMinor: 10000, recordedBaseMinor: 14000, exchangeRate: 140 },
    { ...report.receipts[1], receiptNumber: "REVERSE-03" },
  ];
  report.totals.nativeReceipts = { YER: 10000, SAR: 10000, USD: 0 };
  report.totals.nativeReversals = { YER: 0, SAR: 2500, USD: 0 };
  report.totals.nativeNetRecorded = { YER: 10000, SAR: 7500, USD: 0 };
  report.totals.nativeCashNetRecorded = { YER: 10000, SAR: 10000, USD: 0 };
  report.totals.nativeTransferNetRecorded = { YER: 0, SAR: -2500, USD: 0 };
  report.expenses.movements.forEach((movement, index) => { movement.voucherNumber = `SPEND-0${index + 1}`; });
  report.expenses.movements[1].originalVoucherNumber = "SPEND-01";
  return report;
}
