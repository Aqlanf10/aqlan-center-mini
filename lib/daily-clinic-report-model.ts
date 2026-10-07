import {
  CLINIC_BASE_CURRENCY, CURRENCIES, invoiceNet, patientBalancesByCurrency, requireCurrency, settlePaymentMinor,
  settlementTargetCurrency, toCurrencyPaymentLikes,
  type Currency, type DocumentCurrencyRef,
} from "./money";
import type {
  DailyClinicAgreement, DailyClinicAttendee, DailyClinicReport, DailyClinicSource,
  DailyClinicSourcePlan, DailyClinicWork, DailyCurrencyAmounts,
} from "./daily-clinic-report-types";

export class DailyClinicReportIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "DailyClinicReportIntegrityError"; }
}

export function isDailyClinicReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const dailyCurrencyZero = (): DailyCurrencyAmounts => ({ YER: 0, SAR: 0, USD: 0 });

function money(value: number, label: string, nonnegative = false): number {
  if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) {
    throw new DailyClinicReportIntegrityError(`Invalid minor units: ${label}`);
  }
  return value;
}

function plus(record: DailyCurrencyAmounts, currency: Currency, value: number): void {
  record[currency] = money(record[currency] + value, "aggregate");
}

function uniqueMap<T>(rows: readonly T[], id: (row: T) => string | number): Map<string | number, T> {
  const result = new Map<string | number, T>();
  for (const row of rows) {
    const key = id(row);
    if (result.has(key)) throw new DailyClinicReportIntegrityError(`Duplicate source: ${key}`);
    result.set(key, row);
  }
  return result;
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new DailyClinicReportIntegrityError("Invalid source timestamp");
  return parsed;
}

/** A read projection: canonical patient money and explicit links only. No FIFO allocation. */
export function buildDailyClinicReport(source: DailyClinicSource): DailyClinicReport {
  if (!isDailyClinicReportDate(source.date)) throw new DailyClinicReportIntegrityError("Invalid report date");
  const cutoff = Math.min(instant(source.selectedDayCutoff), instant(source.generatedAt) + 1);
  const visitById = uniqueMap(source.visits, (row) => row.id);
  const planById = uniqueMap(source.plans, (row) => row.id);
  const itemById = uniqueMap(source.items, (row) => row.id);
  const invoiceById = uniqueMap(source.invoices, (row) => row.id);
  uniqueMap(source.payments, (row) => row.id);
  uniqueMap(source.work, (row) => `${row.sourceType}:${row.id}`);
  const invoiceRefs = new Map<number, DocumentCurrencyRef>();
  const planRefs = new Map<number, DocumentCurrencyRef>();
  for (const invoice of source.invoices) {
    money(invoice.totalMinor, "invoice total", true);
    money(invoice.discountMinor, "invoice discount", true);
    if (!["open", "paid", "cancelled"].includes(invoice.status)) {
      throw new DailyClinicReportIntegrityError("Unknown invoice status");
    }
    invoiceRefs.set(invoice.id, { patientId: invoice.patientId,
      currency: requireCurrency(invoice.currency, "فاتورة التقرير", invoice.id) });
  }
  for (const plan of source.plans) {
    money(plan.totalMinor, "agreement principal", true);
    planRefs.set(plan.id, { patientId: plan.patientId,
      currency: requireCurrency(plan.currency, "اتفاق التقرير", plan.id) });
  }
  const checkedPlan = (id: number, patientId: number | null): DailyClinicSourcePlan => {
    const plan = planById.get(id);
    if (!plan || patientId === null || plan.patientId !== patientId) {
      throw new DailyClinicReportIntegrityError("Unresolved or cross-patient agreement link");
    }
    return plan;
  };
  for (const invoice of source.invoices) {
    if (invoice.planId !== null) {
      const plan = checkedPlan(invoice.planId, invoice.patientId);
      if (plan.currency !== invoice.currency) throw new DailyClinicReportIntegrityError("Invoice/plan currency conflict");
    }
  }
  const attendees = new Map<string, DailyClinicAttendee>();
  const patientNames = new Map<number, string>();
  const attendeeKey = (patientId: number | null, visitId: number) => patientId === null ? `visit:${visitId}` : `patient:${patientId}`;
  const signedVisits = new Set<number>();
  const links = new Map<number, Set<number>>();
  const addPlanLink = (planId: number, visitId: number) => {
    const visit = visitById.get(visitId);
    if (!visit) throw new DailyClinicReportIntegrityError("Work outside attendance cohort");
    checkedPlan(planId, visit.patientId);
    const ids = links.get(planId) ?? new Set<number>();
    ids.add(visitId); links.set(planId, ids);
  };
  for (const visit of source.visits) {
    const key = attendeeKey(visit.patientId, visit.id);
    const attendee = attendees.get(key) ?? {
      key, patientId: visit.patientId, patientNumber: visit.patientNumber, patientName: visit.patientName,
      visitIds: [], visitsCount: 0, signedVisitsCount: 0, pendingVisitsCount: 0,
      lateSignedVisitsCount: 0, workSummary: "", agreementIds: [],
      agreement: dailyCurrencyZero(), explicitlySettled: dailyCurrencyZero(),
      agreementRemaining: dailyCurrencyZero(), excludedAgreementCount: 0,
    };
    attendee.visitIds.push(visit.id); attendee.visitsCount++;
    const signed = visit.signedAt !== null && instant(visit.signedAt) < cutoff
      && visit.signedClinicDate !== null && visit.signedClinicDate <= source.date;
    if (signed) { attendee.signedVisitsCount++; signedVisits.add(visit.id); }
    else {
      attendee.pendingVisitsCount++;
      if (visit.signedAt !== null) attendee.lateSignedVisitsCount++;
    }
    if (visit.patientId !== null) patientNames.set(visit.patientId, visit.patientName);
    attendees.set(key, attendee);
    if (visit.plannedPlanId !== null) addPlanLink(visit.plannedPlanId, visit.id);
  }
  for (const row of source.work) {
    const visit = visitById.get(row.visitId);
    if (!visit || row.patientId !== visit.patientId) throw new DailyClinicReportIntegrityError("Cross-patient work source");
    if (row.planId !== null) addPlanLink(row.planId, row.visitId);
    if (row.planItemId !== null) {
      const item = itemById.get(row.planItemId);
      if (!item || item.planId !== row.planId) throw new DailyClinicReportIntegrityError("Unresolved work item");
    }
  }
  for (const link of source.additionalPlanLinks) {
    const visit = visitById.get(link.visitId);
    if (!visit || visit.patientId !== link.patientId) throw new DailyClinicReportIntegrityError("Cross-patient session link");
    addPlanLink(link.planId, link.visitId);
  }

  // Resolve each payment through the existing canonical settlement contract.
  const resolvedPayments = source.payments.map((payment) => {
    money(payment.amountMinor, "receipt amount", true);
    money(payment.baseAmountMinor, "recorded base amount", true);
    if (payment.kind !== "payment" && payment.kind !== "refund") throw new DailyClinicReportIntegrityError("Unknown receipt kind");
    if (!Number.isFinite(payment.exchangeRate) || payment.exchangeRate <= 0) throw new DailyClinicReportIntegrityError("Invalid recorded rate");
    const currency = requireCurrency(payment.currency, "سند التقرير", payment.id);
    const openingCurrency = payment.openingCurrency === null ? null
      : requireCurrency(payment.openingCurrency, "هدف الرصيد الافتتاحي", payment.id);
    if (openingCurrency !== null && (payment.invoiceId !== null || payment.planId !== null)) {
      throw new DailyClinicReportIntegrityError("Conflicting opening settlement target");
    }
    const invoice = payment.invoiceId === null ? null : invoiceById.get(payment.invoiceId);
    if (payment.planId !== null) {
      const plan = checkedPlan(payment.planId, payment.patientId);
      if (invoice && ((invoice.planId !== null && invoice.planId !== plan.id) || invoice.currency !== plan.currency)) {
        throw new DailyClinicReportIntegrityError("Conflicting receipt agreement target");
      }
    }
    const [canonical] = toCurrencyPaymentLikes(payment.patientId,
      [{ ...payment, kind: payment.kind, currency, openingCurrency }], invoiceRefs, planRefs);
    const settlementCurrency = settlementTargetCurrency(canonical, canonical.invoiceCurrency);
    const signedMinor = settlePaymentMinor(canonical, settlementCurrency) * (payment.kind === "refund" ? -1 : 1);
    money(signedMinor, "settlement");
    const targetPlanId = payment.planId ?? invoice?.planId ?? null;
    if (targetPlanId !== null) {
      const plan = checkedPlan(targetPlanId, payment.patientId);
      if (settlementCurrency !== plan.currency) throw new DailyClinicReportIntegrityError("Agreement settlement currency conflict");
    }
    return { source: payment, canonical, openingCurrency, currency, settlementCurrency, signedMinor, targetPlanId };
  });

  const agreements: DailyClinicAgreement[] = [];
  for (const [id, visitIds] of links) {
    const plan = planById.get(id)!;
    const currency = planRefs.get(id)!.currency;
    const payments = resolvedPayments.filter((payment) => payment.targetPlanId === id);
    const paid = money(payments.reduce((sum, payment) => money(sum + payment.signedMinor, "agreement paid"), 0), "agreement paid");
    const included = plan.consentAt !== null && ["active", "completed"].includes(plan.status);
    const agreement: DailyClinicAgreement = {
      id, patientId: plan.patientId, patientName: patientNames.get(plan.patientId) ?? "",
      title: plan.title, status: plan.status, consentAt: plan.consentAt, currency,
      principalMinor: plan.totalMinor, explicitlySettledMinor: paid,
      remainingMinor: included ? Math.max(0, money(plan.totalMinor - paid, "agreement remaining")) : null,
      excessSettlementMinor: included ? Math.max(0, money(paid - plan.totalMinor, "agreement excess")) : 0,
      includedInTotals: included,
      excludedReason: included ? null : plan.consentAt === null ? "خطة بلا موافقة موثقة" : "اتفاق ملغى أو حالة غير مدعومة",
      linkedVisitIds: [...visitIds].sort((a, b) => a - b), paymentIds: payments.map((payment) => payment.source.id),
    };
    agreements.push(agreement);
    const attendee = attendees.get(`patient:${plan.patientId}`)!;
    attendee.agreementIds.push(id);
    if (!included) attendee.excludedAgreementCount++;
    else {
      plus(attendee.agreement, currency, plan.totalMinor);
      plus(attendee.explicitlySettled, currency, paid);
      plus(attendee.agreementRemaining, currency, agreement.remainingMinor!);
    }
  }

  const work: DailyClinicWork[] = [];
  const valuedItemIds = new Set<number>();
  const itemTotals = new Map<number, number>();
  for (const item of source.items) {
    money(item.quantity, "item quantity", true); money(item.unitPriceMinor, "item price", true);
    if (item.status === "cancelled") continue;
    itemTotals.set(item.planId, money((itemTotals.get(item.planId) ?? 0)
      + money(item.quantity * item.unitPriceMinor, "item price total"), "plan item total"));
  }
  for (const row of source.work) {
    if (!signedVisits.has(row.visitId)) continue;
    const visit = visitById.get(row.visitId)!;
    money(row.quantity, "work quantity", true);
    const plan = row.planId === null ? null : checkedPlan(row.planId, visit.patientId);
    const item = row.planItemId === null ? null : itemById.get(row.planItemId);
    let valueMinor: number | null = null;
    let currency: Currency | null = plan ? planRefs.get(plan.id)!.currency : null;
    let valuationBasis: DailyClinicWork["valuationBasis"] = null;
    let unvaluedReason: string | null = "عمل موثق بلا قيمة مستقلة مسجلة";
    if (row.sourceType === "procedure" && row.planId === null && row.unitPriceMinor !== null) {
      valueMinor = money(row.quantity * money(row.unitPriceMinor, "procedure price", true), "procedure value", true);
      // A null visit currency is the documented legacy base-currency convention.
      currency = requireCurrency(visit.billingCurrency ?? CLINIC_BASE_CURRENCY, "عملة الزيارة", visit.id);
      valuationBasis = "recorded_procedure_price"; unvaluedReason = null;
    } else if (item && plan) {
      if (plan.consentAt === null || !["active", "completed"].includes(plan.status)) {
        unvaluedReason = "الاتفاق غير معتمد أو ملغى حاليًا";
      } else if (itemTotals.get(plan.id) !== plan.totalMinor) {
        unvaluedReason = "قيمة البنود لا تطابق المبلغ المقطوع؛ لا توزيع مفترض للاتفاق";
      } else if (item.status === "done" && item.visitId === row.visitId && item.doneAt !== null
        && instant(item.doneAt) < cutoff && item.doneClinicDate === source.date) {
        if (valuedItemIds.has(item.id)) {
          valuationBasis = "included_in_completed_item";
          unvaluedReason = "قيمة البند المحتسبة مرة واحدة في سطر آخر";
        }
        else {
          valueMinor = money(item.quantity * item.unitPriceMinor, "completed item value", true);
          valuationBasis = "completed_plan_item"; unvaluedReason = null; valuedItemIds.add(item.id);
        }
      } else unvaluedReason = "جلسة ضمن بند أو اتفاق؛ لم توثق قيمة مستقلة لهذه الجلسة";
    }
    work.push({
      key: `${row.sourceType}:${row.id}`, patientKey: attendeeKey(visit.patientId, visit.id), patientName: visit.patientName,
      visitId: row.visitId, sourceType: row.sourceType, sourceId: row.id, signedAt: visit.signedAt!,
      description: row.description, quantity: row.quantity, toothCode: row.toothCode,
      doctorName: row.doctorName, agreementId: row.planId,
      classification: plan?.funded ? "included" : row.sourceType === "procedure" && !plan ? "recorded_charge" : "documented_unpriced",
      valueMinor, currency, valuationBasis, unvaluedReason,
    });
  }
  for (const visit of source.visits) {
    if (!signedVisits.has(visit.id) || work.some((row) => row.visitId === visit.id)) continue;
    work.push({ key: `clinical_note:${visit.id}`, patientKey: attendeeKey(visit.patientId, visit.id),
      patientName: visit.patientName, visitId: visit.id, sourceType: "clinical_note", sourceId: visit.id,
      signedAt: visit.signedAt!, description: visit.treatmentDone?.trim() || "زيارة موقعة بلا إجراء مسعر",
      quantity: 1, toothCode: null, doctorName: null, agreementId: null,
      classification: "documented_unpriced", valueMinor: null, currency: null, valuationBasis: null,
      unvaluedReason: "لا قيمة مستقلة مسجلة للعمل الموثق",
    });
  }
  for (const attendee of attendees.values()) {
    attendee.workSummary = [...new Set(work.filter((row) => row.patientKey === attendee.key).map((row) => row.description))].join("، ")
      || "لم يكتمل التوثيق السريري عند نهاية اليوم";
  }

  const currentAccounts: DailyClinicReport["currentAccounts"] = [];
  const openingKeys = new Set<string>();
  const openingsByPatient = new Map<number, Partial<DailyCurrencyAmounts>>();
  for (const opening of source.openings) {
    const currency = requireCurrency(opening.currency, "رصيد التقرير", opening.patientId);
    const key = `${opening.patientId}:${currency}`;
    if (openingKeys.has(key)) throw new DailyClinicReportIntegrityError("Duplicate opening balance");
    openingKeys.add(key);
    const amounts = openingsByPatient.get(opening.patientId) ?? {};
    amounts[currency] = money(opening.amountMinor, "opening balance"); openingsByPatient.set(opening.patientId, amounts);
  }
  for (const [patientId, patientName] of patientNames) {
    const payments = resolvedPayments.filter((payment) => payment.source.patientId === patientId);
    const invoices = source.invoices.filter((invoice) => invoice.patientId === patientId).map((invoice) => ({
        totalMinor: invoice.totalMinor, discountMinor: invoice.discountMinor, status: invoice.status,
        baseCurrency: invoiceRefs.get(invoice.id)!.currency,
      }));
    // The canonical helper is number-based. Reject unsafe intermediate arithmetic
    // before a later refund/credit could turn rounding into a safe-looking residual.
    const checkedBilled = dailyCurrencyZero();
    const checkedSettled = dailyCurrencyZero();
    for (const invoice of invoices) plus(checkedBilled, invoice.baseCurrency, invoiceNet(invoice));
    for (const payment of payments) plus(checkedSettled, payment.settlementCurrency, payment.signedMinor);
    const opening = openingsByPatient.get(patientId) ?? {};
    for (const currency of CURRENCIES) {
      const openingAndBilled = money((opening[currency] ?? 0) + checkedBilled[currency], "opening plus billed");
      money(openingAndBilled - checkedSettled[currency], "current balance subtraction");
    }
    const balances = patientBalancesByCurrency(
      invoices, payments.map((payment) => payment.canonical), opening,
    );
    const byCurrency = {} as DailyClinicReport["currentAccounts"][number]["byCurrency"];
    for (const currency of CURRENCIES) {
      const balance = balances[currency];
      for (const value of Object.values(balance)) money(value, "current account");
      byCurrency[currency] = { openingMinor: balance.openingMinor, billedMinor: balance.billedMinor,
        collectedMinor: balance.collectedMinor, receivableMinor: Math.max(0, balance.dueMinor), creditMinor: Math.max(0, -balance.dueMinor) };
    }
    currentAccounts.push({ patientId, patientName, byCurrency,
      unallocatedPaymentIds: payments.filter((payment) => payment.source.invoiceId === null
        && payment.source.planId === null && payment.openingCurrency === null).map((payment) => payment.source.id) });
  }
  const receipts: DailyClinicReport["receipts"] = resolvedPayments
    .filter((payment) => payment.source.clinicDate === source.date && instant(payment.source.createdAt) < cutoff)
    .map((payment) => ({ id: payment.source.id, receiptNumber: payment.source.receiptNumber,
      patientId: payment.source.patientId, patientName: payment.source.patientName,
      attendee: patientNames.has(payment.source.patientId), at: payment.source.createdAt,
      kind: payment.source.kind as "payment" | "refund", reversalOfId: payment.source.reversalOfId,
      tenderCurrency: payment.currency, tenderMinor: payment.source.amountMinor, method: payment.source.method,
      invoiceId: payment.source.invoiceId, planId: payment.source.planId, openingCurrency: payment.openingCurrency,
      settlementCurrency: payment.settlementCurrency, signedSettlementMinor: payment.signedMinor,
      recordedBaseMinor: payment.source.baseAmountMinor, exchangeRate: payment.source.exchangeRate }));
  const attendeeRows = [...attendees.values()];
  const totals: DailyClinicReport["totals"] = {
    attendeesCount: attendeeRows.length, visitsCount: source.visits.length, signedVisitsCount: signedVisits.size,
    pendingVisitsCount: source.visits.length - signedVisits.size,
    lateSignedVisitsCount: attendeeRows.reduce((sum, row) => sum + row.lateSignedVisitsCount, 0),
    agreement: dailyCurrencyZero(), explicitlySettled: dailyCurrencyZero(), agreementRemaining: dailyCurrencyZero(),
    knownCompletedValue: dailyCurrencyZero(), unvaluedWorkCount: work.filter((row) => row.valueMinor === null
      && row.valuationBasis !== "included_in_completed_item").length,
    currentReceivable: dailyCurrencyZero(), currentCredit: dailyCurrencyZero(),
    nativeReceipts: dailyCurrencyZero(), nativeReversals: dailyCurrencyZero(), nativeNetRecorded: dailyCurrencyZero(),
    nativeCashNetRecorded: dailyCurrencyZero(), nativeTransferNetRecorded: dailyCurrencyZero(),
  };
  for (const row of attendeeRows) for (const currency of CURRENCIES) {
    plus(totals.agreement, currency, row.agreement[currency]);
    plus(totals.explicitlySettled, currency, row.explicitlySettled[currency]);
    plus(totals.agreementRemaining, currency, row.agreementRemaining[currency]);
  }
  for (const row of work) if (row.valueMinor !== null && row.currency !== null) plus(totals.knownCompletedValue, row.currency, row.valueMinor);
  for (const row of currentAccounts) for (const currency of CURRENCIES) {
    plus(totals.currentReceivable, currency, row.byCurrency[currency].receivableMinor);
    plus(totals.currentCredit, currency, row.byCurrency[currency].creditMinor);
  }
  for (const row of receipts) {
    const signed = row.kind === "refund" ? -row.tenderMinor : row.tenderMinor;
    plus(row.kind === "refund" ? totals.nativeReversals : totals.nativeReceipts, row.tenderCurrency, row.tenderMinor);
    plus(totals.nativeNetRecorded, row.tenderCurrency, signed);
    if (row.method === "cash") plus(totals.nativeCashNetRecorded, row.tenderCurrency, signed);
    if (row.method === "transfer") plus(totals.nativeTransferNetRecorded, row.tenderCurrency, signed);
  }
  return {
    date: source.date, clinicTimeZone: source.clinicTimeZone, generatedAt: source.generatedAt,
    selectedDayCutoff: source.selectedDayCutoff,
    basis: { cohort: "arrival_day", account: "current_at_generation", work: "signed_by_cutoff", receipts: "clinicwide_recorded_day" },
    attendees: attendeeRows, agreements, work, currentAccounts, receipts, expenses: source.expenses, totals,
    warnings: [
      "الاتفاقات والمدفوع المربوط بها وأرصدة المرضى هي الحالة الحالية لحظة إعداد التقرير، وليست أرصدة تاريخية مجمدة.",
      "تفصيل العمل يقرأ السجلات الحالية للزيارات الموقعة قبل حد اليوم. أسماء الخدمات والجهات والروابط ليست لقطات تاريخية مجمدة؛ وقد تصف سطور الإجراء والتوثيق التخصصي العمل نفسه، فلا تجمع كعدد إجراءات مستقلة.",
      "متبقي الاتفاق لا يساوي مديونية المريض؛ الدفعات غير المخصصة والأرصدة الافتتاحية لا توزع على الاتفاقات.",
      "قيمة العمل مجموع القيم المسجلة المعروفة فقط: سعر الإجراء قبل خصم الفاتورة، أو قيمة بند خطة اكتمل بكامله. ليست إيرادًا محاسبيًا ولا تقييمًا نسبيًا للجلسات.",
      "الحركات المالية تشمل كل سندات اليوم في المركز، بما فيها من لم يحضر؛ الاستردادات قد تشمل تصحيح التسجيل وليست جميعها ردًا نقديًا فعليًا.",
      ...(agreements.some((row) => !row.includedInTotals) ? ["خطط غير معتمدة أو ملغاة مستبعدة من إجماليات الاتفاقات؛ تفاصيلها ظاهرة للمراجعة."] : []),
      ...(totals.lateSignedVisitsCount > 0 ? ["توجد زيارات وثقت بعد اليوم المختار؛ لا تدخل ضمن الأعمال الموثقة عند نهايته."] : []),
      ...(receipts.some((row) => !["cash", "transfer"].includes(row.method)) ? ["توجد طريقة دفع غير معروفة؛ تظهر ضمن الحركات الكلية ولا تنسب إلى النقد أو الحوالة."] : []),
    ],
  };
}
