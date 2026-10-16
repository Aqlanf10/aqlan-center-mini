'use client';
import Link from 'next/link';
import type { HrCurrentPay } from '@/lib/hr-current-pay';
import { PAY_BLOCKER_LABEL } from '@/lib/hr-pay-terms';
import { HR_CONTRACT_KIND_LABEL, HR_SALARY_PERIOD_LABEL } from '@/lib/hr-shared';
import { CURRENCY_SHORT, formatAmount } from '@/lib/money';
import { hrHref } from '@/lib/hr-navigation';
import { useHrNavigation } from './HrNavigation';

export function CurrentPaySummary({ pay, staffId, compact = false }: { pay?: HrCurrentPay; staffId: number; compact?: boolean }) {
  const navigation = useHrNavigation();
  if (!pay) return <span>تعذّر التحقق من مصدر الأجر.</span>;
  const terms = pay.terms;
  return <div className="space-y-2" aria-label="الأجر الموثق اليوم">
    <p className="font-semibold">{terms?.kind === 'commission' ? 'تعاقد نسبة — بلا راتب ثابت' : terms?.salaryMinor != null && terms.currency
      ? <span><bdi dir="ltr">{formatAmount(terms.salaryMinor, terms.currency)}</bdi> {CURRENCY_SHORT[terms.currency]} — {terms.salaryPeriod ? HR_SALARY_PERIOD_LABEL[terms.salaryPeriod] : 'دورية غير موثقة'}</span>
      : 'مصدر الأجر يحتاج مراجعة'}</p>
    <p className="text-xs text-navy-600">{pay.source === 'contract' ? `المصدر: العقد ${pay.contract?.contractNumber} — إصدار ${pay.contract?.versionNumber}`
      : pay.source === 'staff_profile' ? 'المصدر: شروط الملف الابتدائية' : 'لا مصدر حاكم محسوم'} · يوم العيادة: <bdi>{pay.asOf}</bdi></p>
    {!compact && <>
      {terms && <p className="text-xs">{HR_CONTRACT_KIND_LABEL[terms.kind]} · السريان: <bdi>{pay.effectiveOn ?? 'غير محدد'}</bdi></p>}
      {pay.blockers.length > 0 && <ul className="list-inside list-disc text-xs text-amber-900">{pay.blockers.map(code => <li key={code}>{PAY_BLOCKER_LABEL[code]}</li>)}</ul>}
      {(pay.contract || pay.blockers.length > 0) && <Link prefetch={false} scroll={false} className="inline-block text-sm font-bold text-brand-blue underline" href={(navigation?.href ?? (patch => hrHref('', patch)))({ tab: 'contracts', staffId: String(staffId), contractId: pay.contract ? String(pay.contract.id) : null })}>مراجعة العقد وإضافة ملحق</Link>}
      {terms && ['commission', 'salary_commission'].includes(terms.kind) && <div className="rounded-lg bg-info-50 p-3 text-xs text-info-900">
        <p>نسبة العقد: {pay.contract?.commissionRatePercent ?? 'غير موثقة'}{pay.contract?.commissionRatePercent != null ? '%' : ''}.
          {pay.commissionPolicyPercent != null && <> النسبة الأساسية في سياسة المحرك: {pay.commissionPolicyPercent}%.</>}</p>
        <p>نسبة العقد توثيق للاتفاق. الاحتساب الفعلي يتبع سياسة العمولة المؤرخة وقواعد الخدمات في المحرك المالي. مقارنة النسبة الأساسية اليوم لا تثبت استحقاق الشهر؛ التعارض يمنع اعتماد المسير حتى يُصحّح عبر مساره المعتمد.</p>
        <Link href="/settings/users" prefetch={false} className="mt-2 inline-block font-bold underline">مراجعة سياسة عمولة الطبيب</Link>
      </div>}
      <p className="text-xs text-navy-500">عرض شروط موثقة؛ لا ينشئ استحقاقًا أو صرفًا ولا يعيد الاحتساب.</p>
    </>}
    {compact && pay.blockers.length > 0 && <p className="text-xs text-amber-900">توجد ملاحظات للمراجعة في الملف.</p>}
  </div>;
}
