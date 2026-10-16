'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IDENTITY_ACTION_LABEL, IDENTITY_REASON_LABEL, type IdentityPreview } from '@/lib/hr-identity-preview-shared';

/** Temporary review only. No browser persistence and no mutation/apply affordance. */
export function HrIdentityPreviewPanel() {
  const [preview, setPreview] = useState<IdentityPreview | null>(null);
  const [userIds, setUserIds] = useState<number[]>([]), [partyIds, setPartyIds] = useState<number[]>([]);
  const [staffId, setStaffId] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  const requestPreview = useCallback(async (body?: unknown) => {
    const ticket = ++generation.current;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setPreview(null);
    if (!body) { setUserIds([]); setPartyIds([]); setStaffId(''); setConfirmed(false); }
    try {
      const response = await fetch('/api/hr/identity-preview', { cache: 'no-store', signal: current.signal,
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'تعذّر تحميل المعاينة.');
      if (ticket === generation.current && !current.signal.aborted) setPreview(result as IdentityPreview);
    } catch (failure) {
      if (ticket === generation.current && !current.signal.aborted) setError(failure instanceof Error ? failure.message : 'تعذّر تحميل المعاينة.');
    } finally { if (ticket === generation.current && !current.signal.aborted) setBusy(false); }
  }, []);
  const read = (review = false) => requestPreview(review ? { sourceDigest: preview?.sourceDigest,
    decisions: [{ userIds, partyIds, staffId: staffId ? Number(staffId) : null, confirmedSamePerson: confirmed }] } : undefined);
  const cancelRead = useCallback(() => { generation.current++; controller.current?.abort(); }, []);
  useEffect(() => {
    void requestPreview();
    return cancelRead;
  }, [requestPreview, cancelRead]);
  const toggle = (values: number[], id: number) => values.includes(id) ? values.filter(value => value !== id) : [...values, id];
  return <section aria-labelledby="identity-preview-title" className="space-y-4" dir="rtl">
    <div className="rounded-2xl border border-navy-100 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="identity-preview-title" className="text-lg font-bold text-navy-900">معاينة هوية الطاقم</h2>
        <button type="button" onClick={() => void read()} disabled={busy} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">تحديث المصادر</button>
      </div>
      <p className="mt-3 text-sm leading-7 text-navy-700">معاينة للقراءة فقط. الحساب هو وسيلة الدخول، وملف الموظف هو هوية العمل، والجهة هي الطرف المالي. لا تتغير هنا ملفات أو روابط أو صلاحيات، ولا تُنشأ عقود أو مستحقات.</p>
      <p className="mt-2 text-sm leading-7 text-navy-700">تشابه الأسماء أو اشتراك الجهة لا يثبت أن الحسابات لشخص واحد. أعداد المصادر ليست عدد الموظفين. نسب العمولة وشروط الأجر غير معروضة في هذه المعاينة.</p>
    </div>
    {busy && <p role="status">جارٍ قراءة مصادر الهوية…</p>}
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">{error}</p>}
    {preview && <>
      <dl aria-label="نتائج المعاينة" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(Object.keys(IDENTITY_ACTION_LABEL) as Array<keyof typeof IDENTITY_ACTION_LABEL>).map(action => <div key={action} className="rounded-xl border bg-white p-4"><dt className="text-sm">{IDENTITY_ACTION_LABEL[action]} <span dir="ltr">({action})</span></dt><dd className="mt-2 text-xl font-bold">{preview.counts[action]}</dd></div>)}
      </dl>
      <details className="rounded-2xl border border-navy-100 bg-white p-4">
        <summary className="cursor-pointer font-bold">مراجعة شخص بمعرفات صريحة — مؤقتة</summary>
        <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void read(true); }}>
          <p className="text-sm leading-7">اختر حسابات الشخص وجهته المثبتة وملف HR إن وجد. النتيجة اقتراح للمراجعة اللاحقة فقط، وتزول عند تحديث المصادر أو مغادرة الصفحة.</p>
          <fieldset disabled={busy} className="grid gap-4 md:grid-cols-2">
            <div><h3 className="mb-2 font-bold">الحسابات</h3><div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3">
              {preview.sources.accounts.map(account => <label key={account.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={userIds.includes(account.id)} onChange={() => { setUserIds(toggle(userIds, account.id)); setConfirmed(false); }} aria-label={`اختيار الحساب ${account.id}`} /><span className="break-words">حساب #{account.id} — {account.label} <bdi>({account.role})</bdi>{!account.active && ' — معطل'}</span></label>)}
              {!preview.sources.accounts.length && <p>لا توجد حسابات.</p>}
            </div></div>
            <div><h3 className="mb-2 font-bold">جهة طبيب أو موظف</h3><div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3">
              {preview.sources.parties.filter(p => ['doctor','employee'].includes(p.kind)).map(party => <label key={party.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={partyIds.includes(party.id)} onChange={() => { setPartyIds(toggle(partyIds, party.id)); setConfirmed(false); }} aria-label={`اختيار الجهة ${party.id}`} /><span className="break-words">جهة #{party.id} — {party.label} <bdi>({party.kind})</bdi>{!party.active && ' — غير نشطة'}</span></label>)}
              {!preview.sources.parties.some(p => ['doctor','employee'].includes(p.kind)) && <p>لا توجد جهات طبيب أو موظف.</p>}
            </div></div>
            <label className="space-y-2 text-sm"><span>ملف HR المقصود</span><select aria-label="ملف HR المقصود" value={staffId} onChange={event => { setStaffId(event.target.value); setConfirmed(false); }} className="block w-full rounded-lg border p-2"><option value="">لا يوجد ملف — اقتراح إنشاء هوية غير مكتملة</option>{preview.sources.staff.map(staff => <option key={staff.id} value={staff.id}>ملف #{staff.id} — {staff.label}</option>)}</select></label>
          </fieldset>
          <label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} /><span>أؤكد لهذه المعاينة فقط أن المعرفات المختارة تخص الشخص نفسه.</span></label>
          <button type="submit" disabled={busy || !confirmed || (!userIds.length && !partyIds.length && !staffId)} className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">معاينة الاختيار دون حفظ</button>
        </form>
      </details>
      <div className="space-y-3" aria-label="مرشحو الهوية">
        {!preview.candidates.length && <p className="rounded-xl border bg-white p-4">لا توجد مصادر هوية للمراجعة.</p>}
        {preview.candidates.map(candidate => <article key={candidate.key} data-identity-key={candidate.key} className="space-y-3 rounded-2xl border border-navy-100 bg-white p-4">
          <h3 className="font-bold">{IDENTITY_ACTION_LABEL[candidate.action]} <bdi>({candidate.action})</bdi>{candidate.explicit && ' — اختيار مؤقت'}</h3>
          <ul className="space-y-2 text-sm leading-6">
            {candidate.userIds.map(id => { const a = preview.sources.accounts.find(row => row.id === id); return <li key={`u:${id}`}>حساب #{id}: {a?.label ?? 'مصدر مفقود'} {a && <bdi>({a.role})</bdi>}{a?.partyId && <span> — رابط الحساب المخزن إلى الجهة #{a.partyId}</span>}</li>; })}
            {candidate.staffIds.map(id => { const s = preview.sources.staff.find(row => row.id === id); return <li key={`s:${id}`}>ملف HR #{id}: {s?.label ?? 'مصدر مفقود'}{s?.userId && <span> — رابط الملف المخزن إلى الحساب #{s.userId}</span>}</li>; })}
            {candidate.partyIds.map(id => { const p = preview.sources.parties.find(row => row.id === id); return <li key={`p:${id}`}>جهة #{id}: {p?.label ?? (p ? 'نوع غير متوافق مع الموظفين' : 'مصدر مفقود')} {p && <bdi>({p.kind})</bdi>}</li>; })}
            {preview.sources.contracts.filter(c => candidate.staffIds.includes(c.staffId)).map(c => <li key={`c:${c.id}`}>العقد #{c.id} — ملف #{c.staffId} — <bdi>{c.status}</bdi>{c.partyId && ` — جهة #${c.partyId}`}</li>)}
            {preview.sources.payrollLinks.filter(p => candidate.staffIds.includes(p.staffId)).map(p => <li key={`pay:${p.staffId}:${p.partyId}`}>مرجع مسير سابق: ملف #{p.staffId} ← جهة #{p.partyId}</li>)}
          </ul>
          <ul className={`space-y-1 text-sm leading-6 ${candidate.action === 'conflict' ? 'text-red-800' : 'text-navy-700'}`}>{candidate.reasons.map(reason => <li key={reason}>{IDENTITY_REASON_LABEL[reason]}</li>)}</ul>
          {!!candidate.unknowns.length && <div className="rounded-lg bg-amber-50 p-3 text-sm leading-6"><p className="font-bold">بيانات ناقصة أو تحتاج توثيقًا</p><ul>{candidate.unknowns.map(reason => <li key={reason}>{IDENTITY_REASON_LABEL[reason]}</li>)}</ul></div>}
        </article>)}
      </div>
      <details className="rounded-xl border bg-white p-3 text-xs"><summary>بصمة مصادر المعاينة</summary><p className="mt-2 break-all" dir="ltr">{preview.sourceDigest}</p><p className="mt-2">لتمييز اللقطة فقط؛ ليست إذن تنفيذ أو خطة ترحيل معتمدة.</p></details>
    </>}
  </section>;
}
