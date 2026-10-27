import labelStyles from "./labels.module.css";
import { statementAgreementsRequireReview } from "@/lib/statement-lines";
import { StatementHistoricalDetails, StatementInvoiceDetails, currentStatementInvoices, statementAgreements } from "./presentation";
import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getPatient, getSettingsSafe, ledgerBalancesByCurrency, patientStatementSnapshot } from "@/lib/db";
import {
  CURRENCIES, CURRENCY_LABEL, CLINIC_BASE_CURRENCY, balanceText, formatMoney,
  type Balance, type Currency,
} from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { PatientStatementDocument } from "@/components/PatientStatementDocument";
import { loadPatientStatementDocument } from "@/lib/patient-statement-build";
import { parsePatientStatementOptions, StatementInputError } from "@/lib/patient-statement-options";
import { projectPatientStatement, StatementProjectionError } from "@/lib/patient-statement-projection";
import { financeAccessFor } from "@/lib/finance-permissions";
import { canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { historicalOpeningBuckets } from "@/lib/statement-historical-details";

export const dynamic = "force-dynamic";

/**
 * كشف حساب المريض.
 *
 * الورقة التي تُنهي الجدال على الباب: كل فاتورة وكل دفعة بتاريخها ورقمها، والرصيد
 * في الأسفل. والدفعة بعملة أجنبية تُعرض بعملتها **ومكافئها بسعر يومها** — لا بسعر
 * اليوم، وإلا اختلف الكشف المطبوع أمس عن كشف اليوم لنفس المريض.
 */
type SearchValue = string | string[] | undefined;

export default async function StatementPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, SearchValue>>;
}) {
  // الطبيب لا يرى السندات والفواتير: صفحة الطباعة بابٌ خلفي إلى المال لو تُركت
  // مفتوحة لكل من يملك جلسة.
  const session = await requireSession();
  if (!session || !canViewMoney(session.role)) notFound();
  if ((session.role === "cashier" || session.role === "accountant") && !financeAccessFor(session.role, session.financeAccess).viewPatientLedger) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const query = await searchParams ?? {};
  // The path remains the patient authority; a copied/tampered query cannot retarget it.
  if (query.patientId !== undefined && query.patientId !== String(id)) notFound();
  if (query.type !== undefined || query.to !== undefined || query.from !== undefined) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) notFound();
      if (value !== undefined) search.set(key, value);
    }
    let document;
    try {
      document = await loadPatientStatementDocument(id, parsePatientStatementOptions(search, id));
    } catch (error) {
      if (error instanceof StatementInputError) notFound();
      throw error;
    }
    if (!document) notFound();
    return <><PrintButton /><PatientStatementDocument document={document} /></>;
  }

  // The existing no-query print remains the current, all-history ledger and plan agreement view.
  // Its ledger, plan currencies and agreement progress come from one read-only snapshot, so the
  // receipts, balances and agreement on one sheet always describe the same committed state.
  const [patient, settings, { ledger, planCurrencies, plans, historicalAgreements, statementEvidence }] = await Promise.all([
    getPatient(id), getSettingsSafe(),
    patientStatementSnapshot(id, clinicDateString(new Date(), CLINIC_TIME_ZONE), { historicalAgreements: true, patientFacing: true }),
  ]);
  if (!patient) notFound();

  /* (TD-05) الأساس دستوري من الكود، وكشف الحساب يعرض كل عملةٍ بسطرها الموسوم:
     فاتورةٌ بعملتها، ورصيدٌ لكل عملة — لا رقمٌ واحد يمزج الريال بالسعودي بالدولار. */
  const base = CLINIC_BASE_CURRENCY;
  const balances = ledgerBalancesByCurrency(id, ledger, planCurrencies);
  if (!statementEvidence) throw new StatementProjectionError();
  const patientView = projectPatientStatement({ patientId: id, ledger, planCurrencies, evidence: statementEvidence });
  if (!historicalAgreements) throw new Error("Current statement requires its historical agreements from the same snapshot");
  const historicalBuckets = historicalOpeningBuckets(historicalAgreements, ledger.openings, ledger.payments);
  // Patient handout: a currency whose previous balance is explained by its historical agreements shows those
  // agreements instead of a second opening line (the summary below still counts the opening once).
  const explainedOpenings = new Set(historicalBuckets.filter((bucket) => bucket.agreements.length > 0).map((bucket) => bucket.currency));
  const showInvoiceDetails = currentStatementInvoices(ledger.invoices).length > 0 || historicalAgreements.length === 0;
  const activeCurrencies = CURRENCIES.filter((currency: Currency) => {
    const bucket: Balance = balances[currency];
    return bucket.billedMinor !== 0 || bucket.collectedMinor !== 0
      || bucket.openingMinor !== 0 || bucket.dueMinor !== 0
      || currentStatementInvoices(ledger.invoices).some((invoice) => invoice.baseCurrency === currency);
  });

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4 statement-sheet" dir="rtl">
        <style>{`
          .statement-invoice { margin-bottom: 4mm; table-layout: fixed; }
          .statement-invoice .statement-description { overflow-wrap: anywhere; white-space: pre-wrap; }
          table.statement-invoice td.num, table.statement-invoice th.num { white-space: normal; overflow-wrap: anywhere; }
          @media print {
            /* Keep the closing explanation, divider and contact details together,
               and with the preceding balance/agreement instead of orphaning the footer. */
            .statement-closing { break-inside: avoid-page; page-break-inside: avoid; break-before: avoid-page; page-break-before: avoid; }
            .statement-invoice { break-inside: auto; page-break-inside: auto; }
            .statement-invoice thead { display: table-header-group; }
            .statement-invoice tr { break-inside: avoid; page-break-inside: avoid; }
            .statement-invoice .statement-total { break-before: avoid; page-break-before: avoid; }
          }
        `}</style>
        <PrintHeader settings={settings} title="كشف حساب" />

        <div className="line">
          <span>المريض</span>
          <span style={{ fontWeight: 700 }}>{patient.fullName}</span>
        </div>
        <div className="line">
          <span>رقم الملف</span>
          <span className="num" dir="ltr">{patient.patientNumber}</span>
        </div>
        <div className="rule" />

        {/* (P1-5ب) الرصيد الافتتاحي بعملته — سطرٌ لكل عملة، لا يُحوَّل. */}
        {ledger.openings.filter((opening) => !explainedOpenings.has(opening.currency)).map((opening) => (
          <div className="line" key={opening.currency}>
            <span>رصيد افتتاحي — ما كان على المريض قبل بدء العمل بالبرنامج
            </span>
            <span className="num">{formatMoney(opening.amountMinor, opening.currency)}</span>
          </div>
        ))}

        <StatementHistoricalDetails buckets={historicalBuckets} />

        {showInvoiceDetails ? <StatementInvoiceDetails invoices={ledger.invoices} /> : null}

        <p style={{ fontSize: "10pt", fontWeight: 700, margin: "5mm 0 2mm" }}>الدفعات</p>
        <table className="items">
          <thead>
            <tr>
              <th>السند</th><th>التاريخ</th><th>المدفوع</th><th className="num">المكافئ</th>
            </tr>
          </thead>
          <tbody>
            {patientView.payments.length === 0 ? (
              <tr><td colSpan={4}>لا دفعات</td></tr>
            ) : patientView.payments.map((payment) => (
              <tr key={payment.receiptNumber}>
                <td dir="ltr">{payment.receiptNumber}</td>
                <td>{friendlyDateLong(payment.createdAt.slice(0, 10))}</td>
                <td>
                  {payment.label}{" — "}
                  {formatMoney(payment.amountMinor, payment.currency)}
                </td>
                <td className="num">
                  {payment.kind === "refund" ? "− " : ""}{formatMoney(payment.baseAmountMinor, base)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: "5mm" }}>
          {activeCurrencies.map((currency) => {
            const bucket = balances[currency];
            return (
              <div key={currency} style={{ marginBottom: activeCurrencies.length > 1 ? "3mm" : 0 }}>
                {activeCurrencies.length > 1 ? (
                  <p style={{ fontSize: "10pt", fontWeight: 700, margin: "2mm 0" }}>
                    {CURRENCY_LABEL[currency]}
                  </p>
                ) : null}
                {bucket.openingMinor > 0 ? (
                  <div className="line">
                    <span>رصيد افتتاحي</span>
                    <span className="num">{formatMoney(bucket.openingMinor, currency)}</span>
                  </div>
                ) : null}
                <div className="line">
                  <span>إجمالي المفوتر</span>
                  <span className="num">{formatMoney(bucket.billedMinor, currency)}</span>
                </div>
                <div className={`line ${labelStyles.labelRow}`}>
                  <span>صافي المدفوع</span>
                  <span className="num">{formatMoney(bucket.collectedMinor, currency)}</span>
                </div>
                <div className="line line-strong">
                  <span>الرصيد الحالي</span>
                  <span className="num">{bucket.dueMinor === 0 ? "المستحق الحالي مسدّد" : balanceText(bucket, currency)}</span>
                </div>
              </div>
            );
          })}
        </div>

        {statementAgreementsRequireReview(plans) ? <p role="status">بعض أرصدة اتفاقات العلاج غير متاحة وتحتاج مراجعة مصدرها؛ لا يعني ذلك أنها مسددة. الفواتير وكشف الحساب أعلاه مستقلان عن هذا الملخص.</p> : null}
        {statementAgreements(plans).map((plan) => <div key={plan.id} style={{ marginTop: "4mm" }}>
          <p style={{ fontWeight: 700 }}>اتفاق العلاج — {plan.title}</p>
          <div className="line"><span>إجمالي الاتفاق</span><span>{formatMoney(plan.approvedAgreement ? plan.progress.totalMinor : plan.totalMinor, plan.baseCurrency)}</span></div>
          <div className={`line ${labelStyles.labelRow}`}><span>المسدّد من الاتفاق</span><span>{formatMoney(plan.progress.paidMinor, plan.baseCurrency)}</span></div>
          <div className="line line-strong"><span>المتبقي من الاتفاق</span><span>{formatMoney(plan.progress.remainingMinor, plan.baseCurrency)}</span></div>
          <p className="footer-note">المتبقي من الاتفاق يشمل الأقساط المستقبلية ولا يعني أن كامل المبلغ مستحق الآن.</p>
        </div>)}
        <div className="statement-closing">
          <p className="footer-note" style={{ marginTop: "4mm" }}>
            المبالغ بالعملة الأجنبية محسوبة بسعر صرف يوم الدفع لا بسعر اليوم.
          </p>
          <PrintFooter settings={settings} />
        </div>
      </div>
    </>
  );
}
