import type { Invoice } from "@/lib/db";
import { formatMoney, invoiceNet } from "@/lib/money";
import { friendlyDateLong } from "@/lib/reminders";
import { currentStatementInvoices } from "@/lib/statement-lines";
import type { HistoricalOpeningBucket } from "@/lib/statement-historical-details";

export { currentStatementInvoices, statementAgreements, statementPaymentLabel } from "@/lib/statement-lines";

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

/**
 * Historical treatment agreements registered before the system: saved latest-revision facts in the
 * same detail layout as invoices, but labelled distinctly. Previously-paid is history, not a receipt;
 * current collections settle the opening bucket once per currency, never a document or line.
 */
export function StatementHistoricalDetails({ buckets }: { buckets: readonly HistoricalOpeningBucket[] }) {
  if (buckets.length === 0) return null;
  return <section className="statement-historical" aria-label="اتفاقات العلاج السابقة">
    <h2 style={{ fontSize: "10pt", margin: "2mm 0" }}>اتفاقات علاج سابقة — قبل بدء العمل بالبرنامج</h2>
    {buckets.map((bucket) => <div key={bucket.currency} className="statement-historical-currency" data-historical-currency={bucket.currency}>
      {bucket.agreements.length === 0
        ? <p>تفاصيل العلاج غير مسجلة للرصيد السابق بهذه العملة.</p>
        : bucket.agreements.map((agreement) => <table key={`${agreement.kind}-${agreement.id}`}
          className="items statement-invoice statement-historical-agreement" data-historical-kind={agreement.kind} data-historical-id={agreement.id}>
          <colgroup><col style={{ width: "30%" }} /><col style={{ width: "14%" }} /><col style={{ width: "8%" }} />
            <col style={{ width: "16%" }} /><col style={{ width: "16%" }} /><col style={{ width: "16%" }} /></colgroup>
          <thead>
            <tr><th colSpan={6}>
              {agreement.kind === "document" ? "اتفاق علاج سابق" : "علاج سابق"} <bdi dir="ltr">#{agreement.id}</bdi>
              {" — "}بتاريخ {friendlyDateLong(agreement.historicalAsOf)}
              {agreement.kind === "document" && agreement.version > 1 ? ` — النسخة المصححة ${agreement.version}` : ""}
            </th></tr>
            <tr><th>العلاج / البيان</th><th>الموضع</th><th className="num">الكمية</th>
              <th className="num">سعر الوحدة</th><th className="num">الخصم</th><th className="num">الصافي</th></tr>
          </thead>
          <tbody>
            {agreement.lines.map((line, index) => <tr key={index}>
              <td className="statement-description">{line.description}</td>
              <td>{line.site ?? "—"}</td>
              <td className="num">{line.quantity}</td>
              <td className="num">{formatMoney(line.unitPriceMinor, agreement.currency)}</td>
              <td className="num">{line.discountMinor === null ? "—" : formatMoney(line.discountMinor, agreement.currency)}</td>
              <td className="num">{formatMoney(line.netMinor, agreement.currency)}</td>
            </tr>)}
            <tr className="statement-total"><td colSpan={5}>الإجمالي قبل الخصم</td>
              <td className="num">{formatMoney(agreement.grossMinor, agreement.currency)}</td></tr>
            <tr className="statement-total"><td colSpan={5}>الخصم المسجل</td>
              <td className="num">{formatMoney(agreement.discountMinor, agreement.currency)}</td></tr>
            <tr className="statement-total"><td colSpan={5}>المتفق عليه بعد الخصم</td>
              <td className="num">{formatMoney(agreement.agreedMinor, agreement.currency)}</td></tr>
            <tr className="statement-total"><td colSpan={5}>مدفوع قبل البرنامج (سجل تاريخي — ليس سند قبض حاليًا)</td>
              <td className="num">{formatMoney(agreement.previouslyPaidMinor, agreement.currency)}</td></tr>
            <tr className="statement-total"><td colSpan={5}>المتبقي عند التسجيل — أُضيف إلى الرصيد السابق</td>
              <td className="num">{formatMoney(agreement.remainingMinor, agreement.currency)}</td></tr>
          </tbody>
        </table>)}
      <div className="statement-historical-opening">
        {bucket.openingPrincipalMinor > 0 ? <>
          <div className="line"><span>المحصّل منه في البرنامج بعد الاستردادات</span>
            <span className="num">{formatMoney(bucket.openingCollectedMinor, bucket.currency)}</span></div>
          <div className="line line-strong"><span>المتبقي من الرصيد السابق</span>
            <span className="num">{formatMoney(bucket.openingRemainingMinor, bucket.currency)}</span></div>
          {bucket.openingWithoutStoredDetail && bucket.agreements.length > 0
            ? <p className="footer-note">جزء من الرصيد السابق بهذه العملة لا تقابله تفاصيل علاج مسجلة.</p> : null}
        </> : <p className="footer-note">لا رصيد سابق قائم بهذه العملة.</p>}
      </div>
    </div>)}
  </section>;
}
