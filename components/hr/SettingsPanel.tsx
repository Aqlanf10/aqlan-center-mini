'use client';
import { useEffect, useRef, useState } from 'react';
import { useHrHistoryDrafts } from './HistoryDraftProvider';
import type { HrSettingsPayload } from '@/lib/hr-payroll-shared';
import { normalizeHrPolicy } from '@/lib/hr-settings-policy';
import type { HrPolicyTimelines } from '@/lib/hr-effective-policy';
const field = 'w-full min-w-0 max-w-full rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm';
export function HrSettingsPanel() {
  const { owner, store } = useHrHistoryDrafts(), [data, setData] = useState<HrSettingsPayload | null>(null);
  const [policies, setPolicies] = useState<HrPolicyTimelines | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [currency, setCurrency] = useState('YER'), [salaryDay, setSalaryDay] = useState(''), [cutoffDay, setCutoffDay] = useState(''), [grace, setGrace] = useState('');
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [uncertain, setUncertain] = useState(false), writing = useRef(false);
  const lease = useRef<ReturnType<typeof store.capture> | null>(null);
  useEffect(() => {
    const admitted = store.capture(owner), controller = new AbortController(); lease.current = admitted; admitted.track(controller);
    void (async () => {
      try {
        const response = await fetch('/api/hr/settings', { cache: 'no-store', signal: controller.signal }), value = await response.json();
        if (!admitted.current()) return;
        if (!response.ok) throw new Error(value.message ?? 'تعذّر قراءة الإعدادات.');
        setData(value); setCurrency(value.payrollCycle?.defaultCurrency ?? 'YER'); setSalaryDay(String(value.payrollCycle?.salaryDay ?? '')); setCutoffDay(String(value.payrollCycle?.cutoffDay ?? '')); setGrace(String(value.attendancePolicy?.lateGraceMins ?? '')); setUncertain(false); setError('');
        const policyResponse = await fetch('/api/hr/settings/history', { cache: 'no-store', signal: controller.signal });
        if (policyResponse.ok) { const policyValue = await policyResponse.json(); if (admitted.current()) setPolicies(policyValue.policies); }
      } catch (caught) { if (admitted.current()) setError(caught instanceof Error ? caught.message : 'تعذّر قراءة الإعدادات.'); }
    })();
    return () => { admitted.detach(); if (lease.current === admitted) lease.current = null; };
  }, [store, owner, reload]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); const admitted = lease.current; if (!admitted?.current() || writing.current || uncertain) return;
    let patch: unknown;
    try { patch = { payrollCycle: normalizeHrPolicy('payroll_cycle', { defaultCurrency: currency, salaryDay: Number(salaryDay), cutoffDay: Number(cutoffDay) }, true), attendancePolicy: normalizeHrPolicy('attendance_policy', { lateGraceMins: Number(grace) }, true) }; }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'قيمة غير صالحة.'); return; }
    const controller = new AbortController(); admitted.track(controller); writing.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/hr/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), signal: controller.signal }), value = await response.json();
      if (!admitted.current()) return;
      if (!response.ok) { setError(value.message ?? 'تعذّر حفظ الإعدادات.'); if (response.status >= 500) setUncertain(true); return; }
      setData(value); setNotice('حُفظت الحقول التشغيلية. لم تُنشأ سياسة مؤرخة معتمدة أو خصومات أو استحقاقات.');
    } catch { if (admitted.current()) { setUncertain(true); setError('نتيجة حفظ الإعدادات غير محسومة؛ أعد قراءة القيم المحفوظة قبل تعديلها.'); } }
    finally { if (admitted.current()) { writing.current = false; setBusy(false); } }
  };
  return <section aria-label="إعدادات الموارد البشرية" className="min-w-0 space-y-4 rounded-2xl bg-white p-4 [overflow-wrap:anywhere]">
    <h2 className="text-lg font-bold">إعدادات الموارد البشرية</h2><p className="text-sm">هذه الحقول التشغيلية الحالية لا تثبت استحقاقًا قانونيًا ولا توافق تلقائيًا على خصم أو عمل إضافي.</p>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm">{error}</p>}{notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm">{notice}</p>}
    <button type="button" className="rounded-xl border px-3 py-2 text-sm" disabled={busy} onClick={() => setReload(value => value + 1)}>إعادة قراءة الإعدادات</button>
    {data && <form aria-label="حفظ إعدادات الموارد البشرية" onSubmit={save} className="space-y-3"><fieldset disabled={busy || uncertain} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="grid min-w-0 gap-1 text-sm">العملة الافتراضية<select className={field} value={currency} onChange={event => setCurrency(event.target.value)}>{['YER', 'SAR', 'USD'].map(code => <option key={code}>{code}</option>)}</select></label>
      <label className="grid min-w-0 gap-1 text-sm">يوم الراتب<input className={field} type="number" required min="1" max="31" step="1" value={salaryDay} onChange={event => setSalaryDay(event.target.value)} /></label>
      <label className="grid min-w-0 gap-1 text-sm">يوم الإقفال<input className={field} type="number" required min="1" max="31" step="1" value={cutoffDay} onChange={event => setCutoffDay(event.target.value)} /></label>
      <label className="grid min-w-0 gap-1 text-sm">سماح الحضور بالدقائق<input className={field} type="number" required min="0" max="120" step="1" value={grace} onChange={event => setGrace(event.target.value)} /></label>
    </fieldset><button className="shrink-0 rounded-xl bg-navy-900 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy || uncertain}>{busy ? 'جارٍ الحفظ…' : 'حفظ الإعدادات التشغيلية'}</button></form>}
    <details><summary>القيم الأخرى المسجلة حاليًا — للقراءة</summary><pre className="whitespace-pre-wrap break-all text-xs" dir="ltr">{JSON.stringify({ attendancePolicy: data?.attendancePolicy, leavePolicy: data?.leavePolicy }, null, 2)}</pre></details>
    <h3 className="font-bold">السياسات المؤرخة الموثقة</h3><p className="text-sm">تُعرض الشروط وقرارها المسجل كما هما؛ لا تُحوّل هذه الشاشة القيم الحالية إلى سياسة معتمدة أو معادلة مالية.</p>
    {policies ? Object.entries(policies).map(([key, timeline]) => <article key={key} className="rounded-xl border p-3 text-sm"><h4>{key} — مراجعة {timeline?.revision ?? 0}</h4>{timeline?.facts.length ? timeline.facts.map(fact => <div key={fact.id} className="mt-2"><p>{fact.kind === 'known' ? `${fact.from} → ${fact.to ?? 'مفتوحة'}` : 'سريان غير معروف'}؛ {fact.value.approval.state === 'approved' ? 'قرار موثق' : 'غير معتمدة'}</p><pre dir="ltr" className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(fact, null, 2)}</pre></div>) : <p>لا تاريخ موثق؛ السياسة غير محسومة.</p>}</article>) : <p className="text-sm">التاريخ المؤرخ غير متاح؛ تبقى السياسة غير محسومة.</p>}
  </section>;
}
