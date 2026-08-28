import { notFound } from "next/navigation";
import { asPaymentLikes, getPatient, getSettingsSafe, patientLedger } from "@/lib/db";
import { balanceText, formatMoney, isCurrency, patientBalance } from "@/lib/money";
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

  const [patient, ledger, settings] = await Promise.all([
    getPatient(id), patientLedger(id), getSettingsSafe(),
  ]);
  if (!patient) notFound();

  const base = isCurrency(settings["finance.base_currency"])
    ? settings["finance.base_currency"] : "YER";
  const balance = patientBalance(
    ledger.invoices.map((invoice) => ({
      totalMinor: invoice.totalMinor,
      discountMinor: invoice.discountMinor,
      status: invoice.status,
    })),
    asPaymentLikes(ledger.payments),
    ledger.opening?.amountMinor ?? 0,
  );

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

        {ledger.opening ? (
          <div className="line">
            <span>رصيد افتتاحي — ما كان على المريض قبل بدء العمل بالبرنامج
              {ledger.opening.note ? ` (${ledger.opening.note})` : ""}
            </span>
            <span className="num">{formatMoney(ledger.opening.amountMinor, base)}</span>
          </div>
        ) : null}

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
                  {formatMoney(invoice.status === "cancelled" ? 0 : Math.max(0, invoice.totalMinor - invoice.discountMinor), base)}
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
          {balance.openingMinor > 0 ? (
            <div className="line">
              <span>رصيد افتتاحي</span>
              <span className="num">{formatMoney(balance.openingMinor, base)}</span>
            </div>
          ) : null}
          <div className="line">
            <span>إجمالي المفوتر</span>
            <span className="num">{formatMoney(balance.billedMinor, base)}</span>
          </div>
          <div className="line">
            <span>إجمالي المحصّل</span>
            <span className="num">{formatMoney(balance.collectedMinor, base)}</span>
          </div>
          <div className="line line-strong">
            <span>الرصيد</span>
            <span className="num">{balanceText(balance, base)}</span>
          </div>
        </div>

        <p className="footer-note" style={{ marginTop: "4mm" }}>
          المبالغ بالعملة الأجنبية محسوبة بسعر صرف يوم الدفع لا بسعر اليوم.
        </p>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
