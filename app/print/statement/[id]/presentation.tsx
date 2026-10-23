import type { Invoice } from "@/lib/db";
import { formatMoney, invoiceNet } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { currentStatementInvoices } from "@/lib/statement-lines";

export { currentStatementInvoices, statementPaymentLabel } from "@/lib/statement-lines";

/** Stored invoice evidence, not a repricing of treatment against today's catalogue. */
export function StatementInvoiceDetails({ invoices }: { invoices: readonly Invoice[] }) {
  const current = currentStatementInvoices(invoices);
  return <section className="statement-invoices" aria-label="تفاصيل الفواتير الصحيحة">
    <h2 style={{ fontSize: "10pt", margin: "2mm 0" }}>الفواتير وتفاصيل العلاج</h2>
    {current.length === 0 ? <p>لا فواتير حالية</p> : current.map((invoice) => <table
      key={invoice.id} className="items statement-invoice" data-invoice-id={invoice.id}>
      <colgroup><col style={{ width: "46%" }} /><col style={{ width: "10%" }} />
        <col style={{ width: "22%" }} /><col style={{ width: "22%" }} /></colgroup>
      <thead>
        <tr><th colSpan={4}>
          فاتورة <bdi dir="ltr">{invoice.invoiceNumber}</bdi>
          {" — "}{friendlyDateLong(invoice.createdAt.slice(0, 10))}
          {" — "}{invoice.status === "paid" ? "مسدّدة" : "مفتوحة"}
        </th></tr>
        <tr><th>العلاج / البيان</th><th className="num">الكمية</th>
          <th className="num">سعر الوحدة</th><th className="num">إجمالي البند</th></tr>
      </thead>
      <tbody>
        {invoice.items.length === 0 ? <tr><td colSpan={4}>تفاصيل البنود غير مسجلة لهذه الفاتورة</td></tr>
          : invoice.items.map((item) => <tr key={item.id}>
            <td className="statement-description">{item.description}</td>
            <td className="num">{item.quantity}</td>
            <td className="num">{formatMoney(item.unitPriceMinor, invoice.baseCurrency)}</td>
            <td className="num">{formatMoney(item.totalMinor, invoice.baseCurrency)}</td>
          </tr>)}
        <tr className="statement-total"><td colSpan={3}>الإجمالي قبل الخصم</td>
          <td className="num">{formatMoney(invoice.totalMinor, invoice.baseCurrency)}</td></tr>
        <tr className="statement-total"><td colSpan={3}>الخصم المسجل</td>
          <td className="num">{formatMoney(invoice.discountMinor, invoice.baseCurrency)}</td></tr>
        <tr className="statement-total"><td colSpan={3}>صافي الفاتورة بعد الخصم</td>
          <td className="num">{formatMoney(invoiceNet(invoice), invoice.baseCurrency)}</td></tr>
      </tbody>
    </table>)}
  </section>;
}
