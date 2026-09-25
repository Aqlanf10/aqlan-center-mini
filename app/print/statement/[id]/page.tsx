import { notFound } from "next/navigation";
import { getPatient, getSettingsSafe, ledgerBalancesByCurrency, patientLedger, patientPlanCurrencies } from "@/lib/db";
import {
  CURRENCIES, CURRENCY_LABEL, CLINIC_BASE_CURRENCY, balanceText, formatMoney,
  type Balance, type Currency,
} from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * كشف حساب المريض.
 *
 * الورقة التي تُنهي الجدال على الباب: كل فاتورة وكل دفعة بتاريخها ورقمها، والرصيد
 * في الأسفل. والدفعة بعملة أجنبية تُعرض بعملتها **ومكافئها بسعر يومها** — لا بسعر
 * اليوم، وإلا اختلف الكشف المطبوع أمس عن كشف اليوم لنفس المريض.
 */
export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  // الطبيب لا يرى السندات والفواتير: صفحة الطباعة بابٌ خلفي إلى المال لو تُركت
  // مفتوحة لكل من يملك جلسة.
  const session = await requireSession();
  if (!session || !canHandleMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [patient, ledger, settings, planCurrencies] = await Promise.all([
    getPatient(id), patientLedger(id), getSettingsSafe(), patientPlanCurrencies(id),
  ]);
  if (!patient) notFound();

  /* (TD-05) الأساس دستوري من الكود، وكشف الحساب يعرض كل عملةٍ بسطرها الموسوم:
     فاتورةٌ بعملتها، ورصيدٌ لكل عملة — لا رقمٌ واحد يمزج الريال بالسعودي بالدولار. */
  const base = CLINIC_BASE_CURRENCY;
  const balances = ledgerBalancesByCurrency(id, ledger, planCurrencies);
  const activeCurrencies = CURRENCIES.filter((currency: Currency) => {
    const bucket: Balance = balances[currency];
    return bucket.billedMinor !== 0 || bucket.collectedMinor !== 0
      || bucket.openingMinor !== 0 || bucket.dueMinor !== 0;
  });

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4">
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

        <p style={{ fontSize: "10pt", fontWeight: 700, margin: "2mm 0" }}>الفواتير</p>
        <table className="items">
          <thead>
            <tr>
              <th>الرقم</th><th>التاريخ</th><th>الحالة</th><th className="num">الصافي</th>
            </tr>
          </thead>
          <tbody>
            {ledger.invoices.length === 0 ? (
              <tr><td colSpan={4}>لا فواتير</td></tr>
            ) : ledger.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td dir="ltr">{invoice.invoiceNumber}</td>
                <td>{friendlyDateLong(invoice.createdAt.slice(0, 10))}</td>
                <td>{invoice.status === "cancelled" ? "ملغاة" : invoice.status === "paid" ? "مسدّدة" : "مفتوحة"}</td>
                <td className="num">
                  {formatMoney(invoice.status === "cancelled" ? 0 : Math.max(0, invoice.totalMinor - invoice.discountMinor), invoice.baseCurrency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

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
                  {payment.kind === "refund" ? "استرداد " : ""}
                  {formatMoney(payment.amountMinor, payment.currency)}
                  {payment.currency !== base ? ` (سعر ${payment.exchangeRate})` : ""}
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
                  <span>إجمالي المحصّل</span>
                  <span className="num">{formatMoney(bucket.collectedMinor, currency)}</span>
                </div>
                <div className="line line-strong">
                  <span>الرصيد</span>
                  <span className="num">{balanceText(bucket, currency)}</span>
                </div>
              </div>
            );
          })}
        </div>

        <p className="footer-note" style={{ marginTop: "4mm" }}>
          المبالغ بالعملة الأجنبية محسوبة بسعر صرف يوم الدفع لا بسعر اليوم.
        </p>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
