import { StatementInvoiceDetails, currentStatementInvoices, statementAgreements, statementPaymentLabel } from "./presentation";
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
import { PrintableReportDocument } from "@/components/reports/PrintableReportDocument";
import { buildReport, parseFilters, ReportInputError } from "@/lib/reports";
import { canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * كشف حساب المريض.
 *
 * الورقة التي تُنهي الجدال على الباب: كل فاتورة وكل دفعة بتاريخها ورقمها، والرصيد
 * في الأسفل. والدفعة بعملة أجنبية تُعرض بعملتها **ومكافئها بسعر يومها** — لا بسعر
 * اليوم، وإلا اختلف الكشف المطبوع أمس عن كشف اليوم لنفس المريض.
 */
type SearchValue = string | string[] | undefined;

function isClinicDate(value: SearchValue): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export default async function StatementPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, SearchValue>>;
}) {
  // الطبيب لا يرى السندات والفواتير: صفحة الطباعة بابٌ خلفي إلى المال لو تُركت
  // مفتوحة لكل من يملك جلسة.
  const session = await requireSession();
  if (!session || !canViewMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const query = await searchParams ?? {};
  // The path remains the patient authority; a copied/tampered query cannot retarget it.
  if (query.patientId !== undefined && query.patientId !== String(id)) notFound();
  if (query.to !== undefined || query.from !== undefined) {
    if (!isClinicDate(query.to) || (query.from !== undefined && !isClinicDate(query.from))) notFound();
    const from = query.from ?? query.to;
    if (from > query.to) notFound();
    const filters = parseFilters(new URLSearchParams({
      report: "patient-statement", patientId: String(id), preset: "custom", from, to: query.to,
    }), query.to);
    let result;
    try {
      result = await buildReport("patient-statement", filters);
    } catch (error) {
      if (error instanceof ReportInputError) notFound();
      throw error;
    }
    const settings = await getSettingsSafe();
    const generatedAt = new Intl.DateTimeFormat("ar-YE", {
      timeZone: CLINIC_TIME_ZONE, dateStyle: "medium", timeStyle: "short",
    }).format(new Date());
    return <><PrintButton /><PrintableReportDocument result={result} settings={settings}
      generatedAt={generatedAt} generatedBy={session.username} /></>;
  }

  // The existing no-query print remains the current, all-history ledger and plan agreement view.
  // Its ledger, plan currencies and agreement progress come from one read-only snapshot, so the
  // receipts, balances and agreement on one sheet always describe the same committed state.
  const [patient, settings, { ledger, planCurrencies, plans }] = await Promise.all([
    getPatient(id), getSettingsSafe(), patientStatementSnapshot(id, clinicDateString(new Date(), CLINIC_TIME_ZONE)),
  ]);
  if (!patient) notFound();

  /* (TD-05) الأساس دستوري من الكود، وكشف الحساب يعرض كل عملةٍ بسطرها الموسوم:
     فاتورةٌ بعملتها، ورصيدٌ لكل عملة — لا رقمٌ واحد يمزج الريال بالسعودي بالدولار. */
  const base = CLINIC_BASE_CURRENCY;
  const balances = ledgerBalancesByCurrency(id, ledger, planCurrencies);
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
        {ledger.openings.map((opening) => (
          <div className="line" key={opening.currency}>
            <span>رصيد افتتاحي — ما كان على المريض قبل بدء العمل بالبرنامج
              {opening.note ? ` (${opening.note})` : ""}
            </span>
            <span className="num">{formatMoney(opening.amountMinor, opening.currency)}</span>
          </div>
        ))}

        <StatementInvoiceDetails invoices={ledger.invoices} />

        <p style={{ fontSize: "10pt", fontWeight: 700, margin: "5mm 0 2mm" }}>الدفعات</p>
        <table className="items">
          <thead>
            <tr>
              <th>السند</th><th>التاريخ</th><th>المدفوع</th><th className="num">المكافئ</th>
            </tr>
          </thead>
          <tbody>
            {ledger.payments.length === 0 ? (
              <tr><td colSpan={4}>لا دفعات</td></tr>
            ) : ledger.payments.map((payment) => (
              <tr key={payment.id}>
                <td dir="ltr">{payment.receiptNumber}</td>
                <td>{friendlyDateLong(payment.createdAt.slice(0, 10))}</td>
                <td>
                  {statementPaymentLabel(payment, ledger.payments)}{" — "}
                  {formatMoney(payment.amountMinor, payment.currency)}
                  {payment.currency !== base ? ` (سعر ${payment.exchangeRate})` : ""}
                  {payment.settlementAllocation?<small> — تسوية مصححة {formatMoney(payment.settlementAllocation.targetMinor,payment.settlementAllocation.targetCurrency)}، دون نقد جديد</small>:null}
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
                <div className="line">
                  <span>صافي المحصّل بعد الاستردادات وعكس السندات</span>
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

        {statementAgreements(plans).map((plan) => <div key={plan.id} style={{ marginTop: "4mm" }}>
          <p style={{ fontWeight: 700 }}>اتفاق العلاج — {plan.title}</p>
          <div className="line"><span>إجمالي الاتفاق</span><span>{formatMoney(plan.totalMinor, plan.baseCurrency)}</span></div>
          <div className="line"><span>المسدّد من الاتفاق</span><span>{formatMoney(plan.progress.paidMinor, plan.baseCurrency)}</span></div>
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
