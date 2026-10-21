import { CURRENCY_LABEL, formatMoney } from "@/lib/money";
import type { CheckoutDueRecommendation, CheckoutDueSource } from "@/lib/checkout-due-recommendation";

function sourceLabel(source: CheckoutDueSource): string {
  const target = source.invoiceId === null ? `الرصيد الافتتاحي ${CURRENCY_LABEL[source.currency]}` : `الفاتورة #${source.invoiceId}`;
  if (source.kind === "approved_agreement") return `الاتفاق #${source.authorityId} · ${target}`;
  if (source.kind === "repayment_schedule") return `جدول السداد #${source.authorityId} · ${target}`;
  if (source.kind === "legacy_opening") return `ترتيب الرصيد السابق · ${target}`;
  return `فاتورة الزيارة #${source.invoiceId}`;
}

/** Display only. The aggregate is never supplied to a collection modal. Any
 * schedule/review/multiple-source position routes to canonical target selection. */
export function CheckoutDueSummary({ recommendation }: { recommendation: CheckoutDueRecommendation }) {
  return <section className="space-y-2" aria-label="الاستحقاق الموثق حسب المصدر" data-testid="checkout-due-recommendation">
    {recommendation.currencies.map(row => <section key={row.currency}
      className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs" data-currency={row.currency}>
      <h4 className="font-extrabold text-navy-900">{CURRENCY_LABEL[row.currency]}</h4>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
        <dt>الرصيد الحالي في الدفتر</dt><dd className="text-left font-bold">{formatMoney(row.currentBalanceMinor, row.currency)}</dd>
        <dt>المستحق حسب الجداول وفاتورة الزيارة</dt>
        <dd className="text-left font-extrabold" data-testid="checkout-source-due" data-state={row.status}>
          {row.dueNowMinor === null ? "غير متاح قبل المراجعة" : formatMoney(row.dueNowMinor, row.currency)}
        </dd>
        {row.otherRemainingMinor > 0 ? <><dt>متبقٍ آخر دون موعد مثبت هنا</dt><dd className="text-left font-bold">{formatMoney(row.otherRemainingMinor, row.currency)}</dd></> : null}
      </dl>
      {row.status === "review_required" ? <p role="status" className="mt-2 font-bold text-amber-900">
        {row.reasons.includes("competing_authorities") ? "يوجد أكثر من اتفاق أو جدول على المصدر نفسه؛ لا تُجمع مبالغها ولا يُختار أحدها تلقائيًا. " : ""}
        {row.reasons.includes("source_unavailable") ? "مصدر الدين أو توزيع سداده يحتاج مراجعة. " : ""}
        {row.reasons.includes("unallocated_credit") ? "توجد تسويات تحتاج تخصيصًا قبل تحديد الاستحقاق. " : ""}
        الرصيد المثبت مستقل عن المبلغ غير المتحقق.
      </p> : row.dueNowMinor === 0 && row.currentBalanceMinor > 0 ? <p className="mt-2 text-slate-600">
        لا استحقاق مثبت الآن من الجداول وفاتورة الزيارة؛ هذا لا يعني سداد كامل الرصيد.
      </p> : null}
      {row.sources.length ? <ul className="mt-2 space-y-1" aria-label="مصادر الاستحقاق">
        {row.sources.map(source => <li key={`${source.kind}:${source.authorityId}`} className="flex flex-wrap justify-between gap-2">
          <span>{sourceLabel(source)}</span>
          {row.status === "verified" && source.dueNowMinor !== null ? <span className="font-bold">{formatMoney(source.dueNowMinor, row.currency)}</span> : null}
        </li>)}
      </ul> : null}
    </section>)}
    {recommendation.collectionAction === "account" ? <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs">
      <p>هذه قراءة حسب المصادر، وليست أمر تحصيل واحدًا. اختر الفاتورة أو الرصيد المقصود من الحساب قبل إصدار السند.</p>
      <a href={recommendation.accountHref} target="_blank" rel="noopener" title="يفتح الحساب في تبويب جديد لإبقاء مدخلات الزيارة والتحصيل هنا" className="mt-2 inline-block font-extrabold underline">اختيار مصدر التحصيل ومراجعته من الحساب</a>
    </div> : null}
  </section>;
}
