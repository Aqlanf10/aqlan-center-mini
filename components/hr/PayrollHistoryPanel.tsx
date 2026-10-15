'use client';
import { useEffect, useRef, useState } from 'react';
import { useHrHistoryDrafts } from './HistoryDraftProvider';
import type { HrPayrollHistoryPreview } from '@/lib/hr-payroll-temporal-read';
import { HR_WORK_STATUS_LABEL } from '@/lib/hr-shared';
const field = 'w-full min-w-0 max-w-full rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm';
function blockerLabel(code: string) {
  if (code === 'employment_history_unknown') return 'حالة العمل التاريخية غير معروفة';
  if (code === 'schedule_history_unknown') return 'جدول الموظف التاريخي غير معروف';
  if (code === 'documented_pay_terms_unknown') return 'لا عقد معتمد يثبت شروط الأجر لهذه الفترة';
  if (code.startsWith('proration:')) return 'قرار تقسيم الفترة غير موثق أو غير معتمد';
  if (code.startsWith('employment_pay_effect:')) return 'أثر حالة العمل على الأجر غير موثق أو غير معتمد';
  return `الجدول يحتاج مراجعة: ${code}`;
}
export function HrPayrollHistoryPanel() {
  const { owner, store } = useHrHistoryDrafts(), [staff, setStaff] = useState<{ id: number; fullName: string }[]>([]);
  const [staffId, setStaffId] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [result, setResult] = useState<HrPayrollHistoryPreview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const lease = useRef<ReturnType<typeof store.capture> | null>(null), sequence = useRef(0);
  useEffect(() => {
    const admitted = store.capture(owner), controller = new AbortController(); lease.current = admitted; admitted.track(controller);
    void fetch('/api/hr/staff', { cache: 'no-store', signal: controller.signal }).then(response => response.ok ? response.json() : []).then(value => { if (admitted.current()) setStaff(value.map((person: { id: number; fullName: string }) => ({ id: person.id, fullName: person.fullName }))); }).catch(() => {});
    return () => { admitted.detach(); if (lease.current === admitted) lease.current = null; };
  }, [owner, store]);
  const clear = () => { sequence.current++; setResult(null); setError(''); setBusy(false); };
  const preview = async (event: React.FormEvent) => {
    event.preventDefault(); const admitted = lease.current; if (!admitted?.current()) return;
    const request = ++sequence.current, controller = new AbortController(); admitted.track(controller); setBusy(true); setResult(null); setError('');
    try {
      const response = await fetch(`/api/hr/payroll/history-preview?${new URLSearchParams({ staffId, from, to })}`, { cache: 'no-store', signal: controller.signal }), value = await response.json();
      if (!admitted.current() || request !== sequence.current) return;
      if (!response.ok) { setError(value.message ?? 'تعذّرت المعاينة.'); return; }
      if (value.staffId !== Number(staffId) || value.from !== from || value.to !== to || value.operationalReady !== false) { setError('تعذّر التحقق من سياق المعاينة.'); return; }
      setResult(value);
    } catch { if (admitted.current() && request === sequence.current) setError('تعذّرت المعاينة.'); }
    finally { if (admitted.current() && request === sequence.current) setBusy(false); }
  };
  return <section aria-label="معاينة التاريخ للرواتب" className="min-w-0 space-y-3 rounded-2xl border bg-white p-4 [overflow-wrap:anywhere]">
    <h2 className="font-bold">معاينة التاريخ للرواتب</h2><p className="text-sm">شرح قرائي للفترة كاملة؛ ليس مبلغًا أو اعتمادًا. لا يغيّر المسير المعتمد أو يتجاوز حراس الصرف الحالية.</p>
    <form onSubmit={preview} className="space-y-3"><div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <label className="grid min-w-0 gap-1 text-sm">موظف المعاينة<select className={field} value={staffId} required onChange={event => { clear(); setStaffId(event.target.value); }}><option value="">اختر الموظف</option>{staff.map(person => <option key={person.id} value={person.id}>{person.fullName}</option>)}</select></label>
      <label className="grid min-w-0 gap-1 text-sm">من تاريخ<input className={field} type="date" value={from} required onChange={event => { clear(); setFrom(event.target.value); }} /></label>
      <label className="grid min-w-0 gap-1 text-sm">إلى تاريخ (غير مشمول)<input className={field} type="date" value={to} required onChange={event => { clear(); setTo(event.target.value); }} /></label>
    </div><button className="shrink-0 rounded-xl bg-navy-900 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy}>عرض المعاينة التاريخية</button></form>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm">{error}</p>}
    {result && <div className="space-y-2"><p className="rounded-xl bg-amber-50 p-3 text-sm">{result.warning}</p><p className="text-sm">مراجعة العمل {result.pinnedRevisions.employment}؛ الجدول {result.pinnedRevisions.schedule}؛ تحتاج مراجعة تقسيم الفترة: {result.requiresProrationReview ? 'نعم، بسبب تغير مؤرخ أو تغطية جزئية' : 'لم يُرصد تغير مثبت يستدعيها في المعطيات المتاحة'}.</p>
      {result.partitions.map(part => <article key={part.from} className="rounded-xl border p-3 text-sm"><p dir="ltr">{part.from} → {part.to}</p><p>حالة العمل: {part.employment.kind === 'known' ? HR_WORK_STATUS_LABEL[part.employment.fact.value.status] : 'غير معروفة'}؛ الجدول: {part.schedule.kind === 'known' ? `موثق (${part.schedule.fact.id})` : 'غير معروف'}</p><p>العقد المثبت: {part.contract ? `${part.contract.contractNumber}؛ الإصدار ${part.contract.versionNumber}؛ العملة ${part.contract.currency ?? 'غير محددة'}` : 'لا يوجد عقد معتمد يغطي الجزء'}</p>{part.blockers.length ? <ul>{part.blockers.map(code => <li key={code}>{blockerLabel(code)}</li>)}</ul> : <p>السياق الموثق متاح؛ التفعيل المالي غير متاح في هذه المعاينة.</p>}</article>)}
    </div>}
  </section>;
}
