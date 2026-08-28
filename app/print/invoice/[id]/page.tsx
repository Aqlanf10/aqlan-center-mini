import { notFound } from "next/navigation";
import { getInvoice, getSettingsSafe, printCount } from "@/lib/db";
import { formatMoney, isCurrency } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton, ReprintMark } from "@/components/PrintButton";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** الفاتورة — ورقة A4 كاملة لأنها تحمل بنودًا وقد تُحفظ في ملف المريض. */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  // الطبيب لا يرى السندات والفواتير: صفحة الطباعة بابٌ خلفي إلى المال لو تُركت
  // مفتوحة لكل من يملك جلسة.
  const session = await requireSession();
  if (!session || !canHandleMoney(session.role)) notFound();

  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const [invoice, settings] = await Promise.all([getInvoice(id), getSettingsSafe()]);
  const printed = await printCount("invoice", id);
  if (!invoice) notFound();

  const base = isCurrency(invoice.baseCurrency) ? invoice.baseCurrency : "YER";
  const net = Math.max(0, invoice.totalMinor - invoice.discountMinor);

  return (
    <>
      <PrintButton docType="invoice" docId={id} />
      <ReprintMark printed={printed > 0} />
      <div className="sheet sheet-a4">
        <PrintHeader settings={settings} title="فاتورة" />

        <div className="line">
          <span>رقم الفاتورة</span>
          <span className="num" dir="ltr">{invoice.invoiceNumber}</span>
        </div>
        <div className="line">
          <span>المريض</span>
          <span style={{ fontWeight: 700 }}>{invoice.patientName}</span>
        </div>
        <div className="line">
          <span>التاريخ</span>
          <span>{friendlyDateLong(invoice.createdAt.slice(0, 10))}</span>
        </div>
        {invoice.status === "cancelled" ? (
          <p className="amount-box" style={{ borderStyle: "dashed" }}>ملغاة</p>
        ) : null}

        <div className="rule" />

        <table className="items">
          <thead>
            <tr>
              <th>البند</th>
              <th className="num">الكمية</th>
              <th className="num">السعر</th>
              <th className="num">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item) => (
              <tr key={item.id}>
                <td>{item.description}</td>
                <td className="num" dir="ltr">{item.quantity}</td>
                <td className="num">{formatMoney(item.unitPriceMinor, base)}</td>
                <td className="num">{formatMoney(item.totalMinor, base)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: "4mm" }}>
          <div className="line">
            <span>الإجمالي قبل الخصم</span>
            <span className="num">{formatMoney(invoice.totalMinor, base)}</span>
          </div>
          {invoice.discountMinor > 0 ? (
            <div className="line">
              <span>الخصم</span>
              <span className="num">− {formatMoney(invoice.discountMinor, base)}</span>
            </div>
          ) : null}
          <div className="line line-strong">
            <span>الصافي المستحق</span>
            <span className="num">{formatMoney(net, base)}</span>
          </div>
        </div>

        {invoice.note ? (
          <>
            <div className="rule-light" />
            <p className="footer-note">{invoice.note}</p>
          </>
        ) : null}

        <div className="sign-row">
          <span>المحاسب: ................</span>
          <span>المريض: ................</span>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
