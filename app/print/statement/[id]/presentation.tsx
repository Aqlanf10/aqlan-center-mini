import { PrintTableFrame } from "@/components/PrintDocument";
import type { Invoice } from "@/lib/db";
import { CURRENCY_LABEL, formatMoney, invoiceNet } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { currentStatementInvoices } from "@/lib/statement-lines";
import type { HistoricalOpeningBucket } from "@/lib/statement-historical-details";

export { currentStatementInvoices, statementAgreements, statementPaymentLabel } from "@/lib/statement-lines";

/** Stored invoice evidence, not a repricing of treatment against today's catalogue. */
export function StatementInvoiceDetails({ invoices }: { invoices: readonly Invoice[] }) {
  const current = currentStatementInvoices(invoices);
  return <section className="statement-invoices" aria-label="تفاصيل الفواتير الصحيحة">
    <h2 style={{ fontSize: "10pt", margin: "2mm 0" }}>الفواتير وتفاصيل العلاج</h2>
    {current.length === 0 ? <p>لا فواتير حالية</p> : current.map((invoice) => <PrintTableFrame key={invoice.id}><table
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
    </table></PrintTableFrame>)}
  </section>;
}

/**
 * Treatment agreed before the system, for the patient's printed statement: saved latest-revision facts in the
 * invoice detail layout. Short truthful labels only — the prior payment is "previously paid", never a receipt;
 * internal provenance (ids, versions, opening mechanics) stays in the application and its audit. Current
 * payments and the final balance appear once, in the statement's existing receipt table and summary.
 */
export function StatementHistoricalDetails({ buckets }: { buckets: readonly HistoricalOpeningBucket[] }) {
  const agreements = buckets.flatMap((bucket) => bucket.agreements);
  const undetailed = buckets.filter((bucket) => bucket.openingWithoutStoredDetail);
  // Only genuine historical treatment opens this section; a patient with a manual opening alone prints as before.
  if (agreements.length === 0) return null;
  return <section className="statement-historical" aria-label="العلاج السابق">
    <h2 style={{ fontSize: "10pt", margin: "2mm 0" }}>العلاج السابق</h2>
    {agreements.map((agreement) => <PrintTableFrame key={`${agreement.kind}-${agreement.id}`}><table key={`${agreement.kind}-${agreement.id}`}
      className="items statement-invoice statement-historical-agreement" data-historical-kind={agreement.kind} data-historical-id={agreement.id}>
      <colgroup><col style={{ width: "30%" }} /><col style={{ width: "14%" }} /><col style={{ width: "8%" }} />
        <col style={{ width: "16%" }} /><col style={{ width: "16%" }} /><col style={{ width: "16%" }} /></colgroup>
      <thead>
        <tr><th colSpan={6}>اتفاق علاج بتاريخ {friendlyDateLong(agreement.historicalAsOf)}</th></tr>
        <tr><th>العلاج / البيان</th><th>الموضع</th><th className="num">الكمية</th>
          <th className="num">سعر الوحدة</th><th className="num">الخصم</th><th className="num">الصافي</th></tr>
      </thead>
      <tbody>
        {agreement.lines.map((line, index) => <tr key={index}>
          <td className="statement-description">{line.description}</td>
          <td>{line.site ?? "—"}</td>
          <td className="num">{line.quantity}</td>
          <td className="num">{line.unitPriceMinor === null ? "غير مسجل" : formatMoney(line.unitPriceMinor, agreement.currency)}</td>
          <td className="num">{line.discountMinor === null ? "غير مسجل" : formatMoney(line.discountMinor, agreement.currency)}</td>
          <td className="num">{formatMoney(line.netMinor, agreement.currency)}</td>
        </tr>)}
        {agreement.grossMinor !== null && agreement.discountMinor !== null ? <>
          <tr className="statement-total"><td colSpan={5}>الإجمالي قبل الخصم</td>
            <td className="num">{formatMoney(agreement.grossMinor, agreement.currency)}</td></tr>
          <tr className="statement-total"><td colSpan={5}>الخصم المسجل</td>
            <td className="num">{formatMoney(agreement.discountMinor, agreement.currency)}</td></tr>
        </> : null}
        {/* A standalone agreement records only its agreed amount: no gross or discount row is claimed. */}
        <tr className="statement-total"><td colSpan={5}>المبلغ المتفق عليه</td>
          <td className="num">{formatMoney(agreement.agreedMinor, agreement.currency)}</td></tr>
        <tr className="statement-total"><td colSpan={5}>المدفوع من قبل</td>
          <td className="num">{formatMoney(agreement.previouslyPaidMinor, agreement.currency)}</td></tr>
        <tr className="statement-total"><td colSpan={5}>المبلغ المتبقي</td>
          <td className="num">{formatMoney(agreement.remainingMinor, agreement.currency)}</td></tr>
      </tbody>
    </table></PrintTableFrame>)}
    {undetailed.map((bucket) => <p key={bucket.currency} className="footer-note" data-undetailed-currency={bucket.currency}>
      {bucket.agreements.length === 0 ? "الرصيد السابق" : "جزء من الرصيد السابق"} ({CURRENCY_LABEL[bucket.currency]}) بلا تفاصيل علاج مسجلة.
    </p>)}
  </section>;
}
