import type { TreatmentPlan } from "./db";
import type { Patient } from "./patient";
import { CLINIC_TIME_ZONE, getPatient, getSettingsSafe, ledgerBalancesByCurrency, patientStatementSnapshot } from "./db";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "./money";
import { clinicDateString } from "./schedule";
import { historicalOpeningBuckets } from "./statement-historical-details";
import { projectPatientStatement, StatementProjectionError, type PatientStatementProjection } from "./patient-statement-projection";
import { PATIENT_STATEMENT_TYPES, type PatientStatementDocument } from "./patient-statement-document";
import { StatementInputError, type PatientStatementOptions } from "./patient-statement-options";
import type { SettingsMap } from "./settings";

type Snapshot = Awaited<ReturnType<typeof patientStatementSnapshot>>;
type Section = PatientStatementDocument["sections"][number];
const formatDate = (value: string) => clinicDateString(new Date(value), CLINIC_TIME_ZONE);

/** Use the existing verified financial reader. Never spread a patient-wide payment over plans. */
export function planPosition(plan: TreatmentPlan, today = clinicDateString(new Date(), CLINIC_TIME_ZONE)) {
  const approved = plan.approvedAgreement;
  if (approved) return approved.available ? { total: approved.totalMinor, paid: approved.paidMinor,
    remaining: approved.remainingMinor, due: approved.dueNowMinor } : null;
  if (plan.invoiceFinancial?.kind === "review_required") return null;
  if (plan.debtSource !== "classic_installments" && plan.invoiceFinancial?.kind !== "invoice_backed") return null;
  const p = plan.progress;
  let due: number | null = null;
  if (p.remainingMinor <= 0) due = 0;
  else if (plan.invoiceFinancial) {
    const schedules = plan.invoiceFinancial.schedules.filter(s => s.status === "active");
    // A revision's rows already incorporate settlement SINCE that revision. Subtracting
    // all lifetime payments from their principal would count old cash twice.
    const complete = plan.invoiceFinancial.invoiceIds.every(id => schedules.some(s => s.target.invoiceId === id))
      && schedules.every(s => !s.requiresReview && s.progress !== null);
    if (complete) due = Math.min(p.remainingMinor, schedules.reduce((sum, schedule) => sum
      + schedule.progress!.rows.filter(row => row.dueDate <= today).reduce((total, row) => total + row.remainingMinor, 0), 0));
  } else if (plan.installments.length > 0) {
    due = Math.min(p.remainingMinor, Math.max(0, p.dueToDateMinor - p.paidMinor));
  }
  return { total: p.totalMinor, paid: p.paidMinor, remaining: p.remainingMinor, due };
}
function planSummary(plan: TreatmentPlan, today: string): string[] {
  const p = planPosition(plan, today);
  return [plan.title, CURRENCY_LABEL[plan.baseCurrency], ...([p?.total, p?.paid, p?.remaining, p?.due]
    .map(value => value == null ? "غير متاح" : formatMoney(value, plan.baseCurrency)))];
}
const planColumns = ["العلاج / الاتفاق", "العملة", "القيمة", "المسدّد المخصص", "المتبقي", "المستحق الآن"];

/** A patient-wide due amount requires complete, disjoint, verified sources. Plan
 * principals are never added to the invoices/openings that already back them. */
export function statementDueNowByCurrency(snapshot: Snapshot, projected: PatientStatementProjection, today = clinicDateString(new Date(), CLINIC_TIME_ZONE)) {
  const result = {} as Record<Currency, number | null>;
  for (const currency of CURRENCIES) {
    const balance = projected.balances[currency];
    if (balance.dueMinor <= 0) { result[currency] = 0; continue; }
    const required = new Set(snapshot.ledger.invoices.filter(i => i.status !== "cancelled" && i.baseCurrency === currency).map(i => `invoice:${i.id}`));
    if (balance.openingMinor !== 0) required.add(`opening:${currency}`);
    const covered = new Set<string>();
    let remaining = 0, due = 0, available = true;
    for (const plan of snapshot.plans.filter(p => p.baseCurrency === currency && p.status !== "cancelled")) {
      const position = planPosition(plan, today), approved = plan.approvedAgreement;
      const sources = approved ? [...(approved.invoiceId ? [`invoice:${approved.invoiceId}`] : []),
        ...(approved.openingCurrency ? [`opening:${approved.openingCurrency}`] : []), ...(approved.deltaInvoiceIds ?? []).map(id => `invoice:${id}`)]
        : (plan.invoiceFinancial?.invoiceIds ?? []).map(id => `invoice:${id}`);
      if (!sources.length) continue;
      if (!position || position.due === null || sources.some(key => covered.has(key) || !required.has(key))) { available = false; break; }
      sources.forEach(key => covered.add(key));
      remaining += position.remaining; due += position.due;
      if (!Number.isSafeInteger(remaining) || !Number.isSafeInteger(due)) throw new StatementProjectionError();
    }
    result[currency] = available && covered.size === required.size && remaining === balance.dueMinor ? due : null;
  }
  return result;
}
function planDetails(plan: TreatmentPlan): Section {
  return { title: `خدمات العلاج — ${plan.title}`, columns: ["الخدمة", "السن / الموضع", "الكمية", "سعر الوحدة", "القيمة", "حالة العلاج"],
    rows: plan.items.filter(item => item.status !== "cancelled").map(item => [item.serviceName,
      [item.toothCode, item.surfaces, item.caseSite].filter(value => value != null && value !== "").join(" / ") || "—",
      String(item.quantity), formatMoney(item.unitPriceMinor, plan.baseCurrency), formatMoney(item.totalMinor, plan.baseCurrency),
      item.status === "done" ? "منتهٍ سريريًا" : "جارٍ"] ) };
}

/** Select whole sources already verified by the canonical plan reader. No amount,
 * date or description matching and no proportional allocation of unlinked cash. */
export function treatmentStatementRows(snapshot: Snapshot, projected: PatientStatementProjection, plan: TreatmentPlan, today = clinicDateString(new Date(), CLINIC_TIME_ZONE)): Section[] {
  if (!planPosition(plan, today)) return [];
  const approved = plan.approvedAgreement;
  const invoiceIds = new Set(approved ? [...(approved.invoiceId ? [approved.invoiceId] : []), ...(approved.deltaInvoiceIds ?? [])]
    : plan.invoiceFinancial?.invoiceIds ?? []);
  const predecessor = new Map((snapshot.statementEvidence?.invoiceCorrections ?? []).map(edge => [edge.correctedInvoiceId, edge.originalInvoiceId]));
  for (const id of [...invoiceIds]) {
    let cursor = predecessor.get(id);
    while (cursor !== undefined && !invoiceIds.has(cursor)) { invoiceIds.add(cursor); cursor = predecessor.get(cursor); }
  }
  const receipts = new Set(snapshot.ledger.payments.filter(payment =>
    (payment.invoiceId !== null && invoiceIds.has(payment.invoiceId))
    || (approved?.openingCurrency != null && payment.openingCurrency === approved.openingCurrency)
    || (plan.debtSource === "classic_installments" && payment.planId === plan.id)).map(payment => payment.receiptNumber));
  const invoices = new Set(snapshot.ledger.invoices.filter(invoice => invoiceIds.has(invoice.id)).map(invoice => invoice.invoiceNumber));
  return [{ title: "الفواتير المرتبطة بالعلاج", columns: ["الفاتورة", "التاريخ", "الخصم", "الصافي"], rows: projected.invoices.filter(invoice => invoices.has(invoice.invoiceNumber)).map(invoice => [invoice.invoiceNumber, formatDate(invoice.createdAt), formatMoney(invoice.discountMinor, invoice.baseCurrency), formatMoney(invoice.netMinor, invoice.baseCurrency)]) },
    { title: "الدفعات المخصصة للعلاج", columns: ["السند", "التاريخ", "البيان", "المبلغ", "المسدّد من الحساب"], rows: projected.payments.filter(payment => receipts.has(payment.receiptNumber)).map(payment => [payment.receiptNumber, formatDate(payment.createdAt), payment.label, formatMoney(payment.amountMinor, payment.currency), formatMoney(payment.settlementMinor, payment.settlementCurrency)]) }];
}

/** Only allowlisted patient text enters this document; it is also the local export payload. */
export function assemblePatientStatement(patient: Pick<Patient, "fullName" | "patientNumber" | "phone">,
  settings: SettingsMap, snapshot: Snapshot, projected: PatientStatementProjection,
  options: PatientStatementOptions, generatedAt: string, today = clinicDateString(new Date(), CLINIC_TIME_ZONE)): PatientStatementDocument {
  const sections: Section[] = [];
  const notices: string[] = [];
  const plans = snapshot.plans.filter(plan => plan.status !== "cancelled");
  const document: PatientStatementDocument = {
    patient: { name: patient.fullName, number: patient.patientNumber, phone: patient.phone },
    title: `كشف حساب — ${PATIENT_STATEMENT_TYPES[options.type]}`,
    generatedAt,
    clinic: { name: settings["clinic.name"] ?? "", doctor: [settings["clinic.lead_doctor"], settings["clinic.lead_doctor_title"]].filter(Boolean).join(" — "),
      credentials: settings["clinic.lead_doctor_credentials"], address: settings["clinic.address"], phone: settings["clinic.phone"] },
    sections, notices, treatments: plans.map(plan => ({ id: plan.id, title: plan.title })),
  };
  if (options.type === "period") {
    const period = projected.period;
    if (!period) throw new StatementProjectionError();
    document.subtitle = `من ${period.from} إلى ${period.to} — بحسب تاريخ المركز`;
    sections.push({ title: "رصيد الفترة حسب العملة", columns: ["العملة", "رصيد أول الفترة", "رصيد آخر الفترة"],
      rows: CURRENCIES.map(currency => [CURRENCY_LABEL[currency], formatMoney(period.opening[currency], currency), formatMoney(period.closing[currency], currency)]) });
    sections.push({ title: "حركات الفترة", columns: ["التاريخ", "البيان", "مدين", "دائن", "الرصيد"],
      rows: period.movements.map(row => [row.date, row.description, formatMoney(row.debitMinor, row.currency), formatMoney(row.creditMinor, row.currency), formatMoney(row.balanceMinor, row.currency)]) });
    notices.push("رصيد أول الفترة يشمل ما قبل بدايتها. الرصيد السالب مبلغ لصالح المريض. الحركات معروضة بصافي أثرها اليومي لكل عملة.");
    return document;
  }
  if (options.type === "treatment") {
    const plan = plans.find(candidate => candidate.id === options.treatmentId);
    if (!plan) throw new StatementInputError("العلاج المحدد غير موجود لهذا المريض.");
    sections.push({ title: "العلاج المحدد", columns: planColumns, rows: [planSummary(plan, today)] }, planDetails(plan), ...treatmentStatementRows(snapshot, projected, plan, today));
    notices.push("المسدّد يخص هذا العلاج وفق الروابط المثبتة فقط. الدفعات غير المخصصة لا تُوزّع على العلاجات تقديريًا.");
    if (!planPosition(plan, today)) notices.push("تعذّر التحقق من رصيد هذا العلاج؛ لا تعني عبارة غير متاح أن الحساب مسدد.");
    return document;
  }
  if (options.type === "ongoing") {
    const completed = (plan: TreatmentPlan) => plan.status === "completed" || (plan.items.some(item => item.status !== "cancelled")
      && plan.items.every(item => item.status === "done" || item.status === "cancelled"));
    const ongoing = plans.filter(plan => !completed(plan));
    const completedWithDebt = plans.filter(plan => completed(plan) && (planPosition(plan, today)?.remaining ?? 0) > 0);
    const completedUnknown = plans.filter(plan => completed(plan) && !planPosition(plan, today));
    sections.push({ title: "العلاج الجاري", columns: planColumns, rows: ongoing.map(plan => planSummary(plan, today)) });
    sections.push({ title: "علاج منتهٍ سريريًا وبقيت عليه مديونية", columns: planColumns, rows: completedWithDebt.map(plan => planSummary(plan, today)) });
    if (completedUnknown.length) sections.push({ title: "علاج منتهٍ سريريًا — الرصيد غير متاح", columns: planColumns, rows: completedUnknown.map(plan => planSummary(plan, today)) });
    for (const plan of [...ongoing, ...completedWithDebt, ...completedUnknown]) sections.push(planDetails(plan));
    notices.push("اكتمال العلاج سريريًا لا يعني سداد رصيده. المبالغ غير المتاحة تحتاج مراجعة ولا تُعرض كصفر.");
    return document;
  }
  sections.push({ title: "ملخص الحساب حسب العملة", columns: ["العملة", "قيمة العلاج المفوترة", "الرصيد السابق", "صافي المدفوع", "المتبقي في الحساب"],
    rows: CURRENCIES.map(currency => { const b = projected.balances[currency]; return [CURRENCY_LABEL[currency],
      formatMoney(b.billedMinor, currency), formatMoney(b.openingMinor, currency), formatMoney(b.collectedMinor, currency), formatMoney(b.dueMinor, currency)]; }) });
  const dueNow = statementDueNowByCurrency(snapshot, projected, today);
  sections.push({ title: "المستحق الآن حسب العملة", columns: ["العملة", "المستحق الآن"], rows: CURRENCIES.map(currency => [CURRENCY_LABEL[currency],
    dueNow[currency] === null ? "غير متاح" : formatMoney(dueNow[currency], currency)]) });
  if (CURRENCIES.some(currency => dueNow[currency] === null)) notices.push("بعض مواعيد الاستحقاق غير متاحة في هذا الكشف. المتبقي في الحساب ظاهر، ولا يُعد كامل الرصيد مستحقًا الآن دون موعد سداد مثبت.");
  if (plans.length) {
    sections.push({ title: "أرصدة العلاجات والاتفاقات", columns: planColumns, rows: plans.map(plan => planSummary(plan, today)) });
    notices.push("قيم العلاجات والاتفاقات مرجع مستقل؛ لا تُضاف إلى قيمة الفواتير أو الرصيد السابق مرة أخرى. المتبقي قد يشمل أقساطًا مستقبلية.");
  }
  notices.push("الرصيد السالب مبلغ لصالح المريض. العملات مستقلة، وتسوية الدفعة بعملة مختلفة تعتمد القيمة المثبتة وقت السداد.");
  if (options.type === "summary") return document;
  for (const invoice of projected.invoices) {
    sections.push({ title: `فاتورة ${invoice.invoiceNumber} — ${formatDate(invoice.createdAt)}`, columns: ["الخدمة", "السن / الموضع", "الكمية", "سعر الوحدة", "الإجمالي"],
      rows: invoice.items.map(item => [item.description, [item.toothCode, item.surfaces].filter(value => value != null).join(" / ") || "—",
        String(item.quantity), formatMoney(item.unitPriceMinor, invoice.baseCurrency), formatMoney(item.totalMinor, invoice.baseCurrency)]) });
    sections.push({ title: `قيمة الفاتورة ${invoice.invoiceNumber}`, columns: ["قبل الخصم", "الخصم المسجل", "الصافي"], rows: [[
      formatMoney(invoice.totalMinor, invoice.baseCurrency), formatMoney(invoice.discountMinor, invoice.baseCurrency), formatMoney(invoice.netMinor, invoice.baseCurrency)]] });
  }
  sections.push({ title: "الدفعات والاستردادات", columns: ["السند", "التاريخ", "البيان", "المبلغ", "المسدّد من الحساب"], rows: projected.payments.map(payment => [
    payment.receiptNumber, formatDate(payment.createdAt), payment.label, formatMoney(payment.amountMinor, payment.currency), formatMoney(payment.settlementMinor, payment.settlementCurrency)]) });
  if (snapshot.historicalAgreements) {
    const buckets = historicalOpeningBuckets(snapshot.historicalAgreements, snapshot.ledger.openings, snapshot.ledger.payments);
    for (const agreement of buckets.flatMap(bucket => bucket.agreements)) {
      sections.push({ title: `العلاج السابق — ${agreement.historicalAsOf}`, columns: ["العلاج", "الموضع", "سعر الوحدة", "الخصم", "الصافي"], rows: agreement.lines.map(line => [line.description, line.site ?? "—",
        line.unitPriceMinor === null ? "غير مسجل" : formatMoney(line.unitPriceMinor, agreement.currency),
        line.discountMinor === null ? "غير مسجل" : formatMoney(line.discountMinor, agreement.currency), formatMoney(line.netMinor, agreement.currency)]) });
      sections.push({ title: "ملخص العلاج السابق", columns: ["القيمة المتفق عليها", "المدفوع سابقًا", "المتبقي المسجل"], rows: [[formatMoney(agreement.agreedMinor, agreement.currency), formatMoney(agreement.previouslyPaidMinor, agreement.currency), formatMoney(agreement.remainingMinor, agreement.currency)]] });
    }
    if (buckets.some(bucket => bucket.agreements.length)) notices.push("تفاصيل العلاج السابق تفسّر الرصيد السابق؛ لا تضيف مديونية جديدة ولا تُعد الدفعات التاريخية تحصيلًا جديدًا.");
  }
  return document;
}

export async function loadPatientStatementDocument(patientId: number, options: PatientStatementOptions) {
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const [patient, settings, snapshot] = await Promise.all([getPatient(patientId), getSettingsSafe(),
    patientStatementSnapshot(patientId, today, { historicalAgreements: options.type !== "period", patientFacing: true })]);
  if (!patient) return null;
  if (!snapshot.statementEvidence) throw new StatementProjectionError();
  const projected = projectPatientStatement({ patientId, ledger: snapshot.ledger, planCurrencies: snapshot.planCurrencies, evidence: snapshot.statementEvidence }, options);
  if (options.type !== "period" && JSON.stringify(projected.balances) !== JSON.stringify(ledgerBalancesByCurrency(patientId, snapshot.ledger, snapshot.planCurrencies))) throw new StatementProjectionError();
  return assemblePatientStatement(patient, settings, snapshot, projected, options,
    new Intl.DateTimeFormat("ar-YE", { timeZone: CLINIC_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date()), today);
}
