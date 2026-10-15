'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/Modal';
import { useHrHistoryDrafts } from './HistoryDraftProvider';
import { canonicalHrIntent, matchingHrHistoryReceipt, parseHrHistoryCommand, type HrHistoryCommand, type HrHistoryKind } from '@/lib/hr-temporal-request';
import type { HrRecordedHistory } from '@/lib/hr-temporal-read';
import type { HrHistoryLease } from '@/lib/hr-history-drafts';
import type { HrScheduleSegment } from '@/lib/hr-schedule-segments';
import { HR_WORK_STATUS_LABEL } from '@/lib/hr-shared';
import { CLINIC_ZONE_FALLBACK } from '@/lib/clinicZone';

const field = 'w-full min-w-0 max-w-full rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm';
const button = 'shrink-0 rounded-xl border border-navy-200 px-3 py-2 text-sm font-semibold disabled:opacity-50';
const weekdays = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export function HrHistoryLauncher({ staffId, label, kind }: { staffId: number; label: string; kind: HrHistoryKind }) {
  const [open, setOpen] = useState(false), { owner } = useHrHistoryDrafts();
  const title = kind === 'employment' ? 'تاريخ العمل' : 'نسخ جدول الموظف';
  return <><button type="button" className={button} onClick={() => setOpen(true)} aria-label={`${title}: ${label}`}>{title}</button>
    {open && <HistoryEditor key={`${owner}:${staffId}:${kind}`} staffId={staffId} kind={kind} label={label} onClose={() => setOpen(false)} />}</>;
}
function HistoryEditor({ staffId, kind, label, onClose }: { staffId: number; kind: HrHistoryKind; label: string; onClose(): void }) {
  const { owner, username, store } = useHrHistoryDrafts(), scope = `${kind}:${staffId}`, pending = store.get(owner, scope);
  const initial = pending?.append.at(-1), initialValue = initial?.value;
  const [data, setData] = useState<HrRecordedHistory | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'add' | 'correct' | 'version'>('add'), [originalId, setOriginalId] = useState('');
  const [from, setFrom] = useState(initial?.kind === 'known' ? initial.from : ''), [to, setTo] = useState(initial?.kind === 'known' ? initial.to ?? '' : '');
  const [status, setStatus] = useState(initialValue && 'status' in initialValue ? initialValue.status : 'active');
  const [reason, setReason] = useState(pending?.reason ?? '');
  const [zone, setZone] = useState(initialValue && 'timeZone' in initialValue ? initialValue.timeZone : CLINIC_ZONE_FALLBACK);
  const [days, setDays] = useState<readonly number[]>(initialValue && 'workingDays' in initialValue ? initialValue.workingDays : []);
  const [grace, setGrace] = useState(initialValue && 'graceMins' in initialValue ? String(initialValue.graceMins) : '0');
  const [segments, setSegments] = useState<readonly HrScheduleSegment[]>(initialValue && 'segments' in initialValue ? initialValue.segments : [{ id: 'segment-1', start: '08:00', startDayOffset: 0, end: '16:00', endDayOffset: 0 }]);
  const lease = useRef<HrHistoryLease | null>(null), requestIndex = useRef(0), inFlight = useRef(false);
  const endpoint = `/api/hr/staff/${staffId}/${kind === 'employment' ? 'history' : 'schedule-history'}`;
  const load = useCallback(async (revision?: number) => {
    const admitted = lease.current; if (!admitted?.current()) return;
    const sequence = ++requestIndex.current, controller = new AbortController(); admitted.track(controller); setLoading(true);
    try {
      const response = await fetch(endpoint + (revision === undefined ? '' : `?revision=${revision}`), { cache: 'no-store', signal: controller.signal });
      const result = await response.json(); if (!admitted.current() || sequence !== requestIndex.current) return;
      if (!response.ok) { setData(null); setError(result.message ?? 'تعذّر قراءة التاريخ.'); return; }
      if (result.staffId !== staffId || result.kind !== kind) { setData(null); setError('تعذّر التحقق من هوية السجل.'); return; }
      setData(result); setError('');
    } catch { if (admitted.current() && sequence === requestIndex.current) setError('تعذّر قراءة التاريخ. أعد التحميل.'); }
    finally { if (admitted.current() && sequence === requestIndex.current) setLoading(false); }
  }, [endpoint, staffId, kind]);
  useEffect(() => {
    const admitted = store.capture(owner); lease.current = admitted; void load();
    return () => { admitted.detach(); if (lease.current === admitted) lease.current = null; };
  }, [store, owner, load]);
  const facts = data?.timeline.facts.filter(fact => fact.kind === 'known') ?? [];
  const original = facts.find(fact => fact.id === originalId);
  const historicalView = data !== null && data.timeline.revision !== data.headRevision;
  const chooseOriginal = (id: string) => {
    setOriginalId(id); const fact = facts.find(item => item.id === id); if (!fact) return;
    setFrom(fact.from); setTo(fact.to ?? '');
    if ('status' in fact.value) setStatus(fact.value.status);
    else { setZone(fact.value.timeZone); setDays(fact.value.workingDays); setGrace(String(fact.value.graceMins)); setSegments(fact.value.segments); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); const admitted = lease.current; if (!data || !admitted?.current() || inFlight.current) return;
    const wasUncertain = Boolean(store.get(owner, scope)); let command: HrHistoryCommand;
    try {
      const retained = store.get(owner, scope);
      if (retained) command = retained;
      else {
        if (historicalView) throw new Error('حمّل أحدث مراجعة قبل توثيق تغيير.');
        const value = kind === 'employment' ? { status } : { timeZone: zone, workingDays: days, graceMins: Number(grace), segments };
        const id = `fact-${crypto.randomUUID()}`, supersedeIds: string[] = [];
        const append = [{ id, kind: 'known' as const, from, to: to || null, value }];
        if (mode !== 'add') {
          if (!original) throw new Error('اختر الفترة الأصلية للمراجعة.');
          supersedeIds.push(original.id);
          if (mode === 'version') {
            if (from <= original.from || (original.to !== null && from >= original.to)) throw new Error('بداية النسخة الجديدة تقع داخل الفترة الأصلية وبعد بدايتها.');
            append[0].to = original.to;
            append.unshift({ id: `fact-${crypto.randomUUID()}`, kind: 'known', from: original.from, to: from, value: original.value });
          }
        }
        command = parseHrHistoryCommand({ requestId: `hr-${crypto.randomUUID()}`, expectedUsername: username, expectedRevision: data.headRevision, reason, supersedeIds, append }, kind, staffId);
        if (!store.reserve(owner, scope, admitted, command)) return;
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'راجع الفترة والجدول.'); return; }
    const controller = new AbortController(); admitted.track(controller); inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const { staffId: ignoredSubject, operation: ignoredOperation, ...body } = command;
      void ignoredSubject; void ignoredOperation;
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const result = await response.json(); if (!admitted.current()) return;
      if (response.ok && matchingHrHistoryReceipt(result, command, username)) {
        if (store.settle(owner, scope, admitted, command)) { setNotice(`تم توثيق المراجعة ${result.revision} بإيصال مطابق؛ ${kind === 'employment' ? 'تُقرأ الحالة التشغيلية حسب تاريخ السريان، دون حساب أجر أو خصم.' : 'الجدول موثق للمراجعة دون تفعيل حساب الحضور أو الأجر.'}`); if (kind === 'employment') window.dispatchEvent(new Event('hr-employment-changed')); setReason(''); setOriginalId(''); setMode('add'); await load(); }
      } else {
        // Only a matching first refusal permits editing. An uncertain command keeps its identity/body.
        const refused = result.refusal?.confirmedNoCommitAttempt === true && canonicalHrIntent(result.refusal.intent) === canonicalHrIntent(command);
        if (!wasUncertain && refused) store.settle(owner, scope, admitted, command);
        setError(result.message ?? 'النتيجة غير مطابقة. أعد الطلب نفسه للتحقق؛ لم يُغيّر مفتاحه أو محتواه.');
      }
    } catch { if (admitted.current()) setError('النتيجة غير محسومة؛ أعد إرسال الطلب المحفوظ نفسه للتحقق، حتى بعد إغلاق النافذة وإعادة فتحها.'); }
    finally { if (admitted.current()) { inFlight.current = false; setBusy(false); } }
  };
  const updateSegment = (index: number, patch: Partial<HrScheduleSegment>) => setSegments(current => current.map((segment, i) => i === index ? { ...segment, ...patch } : segment));
  const title = `${kind === 'employment' ? 'تاريخ العمل' : 'نسخ جدول الموظف'}: ${label}`;
  return <Modal alignTop label={title} onClose={onClose}>
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4 rounded-2xl bg-white p-4 shadow-raised [overflow-wrap:anywhere] [&_div]:min-w-0 [&_fieldset]:min-w-0 [&_label]:min-w-0 [&_input]:min-w-0 [&_input]:max-w-full [&_select]:min-w-0 [&_select]:max-w-full [&_textarea]:min-w-0 [&_textarea]:max-w-full">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="rounded-xl bg-amber-50 p-3 text-sm">{kind === 'employment' ? 'تُشتق الحالة التشغيلية من أحدث تاريخ موثق ويوم العيادة؛ الفجوة غير معروفة وتمنع الإسناد الجديد. عند توثيق أول فترة مستقبلية، وثّق الحالة الحالية أيضًا إن كانت معلومة.' : 'الجدول موثق للمراجعة فقط؛ لا يفعّل حساب الحضور أو الأجر.'} لا ينشئ استحقاقًا أو خصمًا. فترة السريان لا تشمل يوم النهاية. هوية الموظف مستقلة عن حساب الدخول وهوية الطبيب المعالج.</p>
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm">{notice}</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => void load()}>إعادة تحميل أحدث مراجعة</button><button type="button" className={button} onClick={onClose}>إغلاق التاريخ</button></div>
      {loading && <p>جارٍ تحميل التاريخ…</p>}
      {data && <>
        <p className="text-sm">المراجعة المعروضة: {data.timeline.revision}؛ الأحدث: {data.headRevision}. الحالة المؤرخة في <bdi>{data.asOfDay}</bdi>: {data.selected.kind === 'unknown' ? 'غير معروفة' : 'status' in data.selected.fact.value ? HR_WORK_STATUS_LABEL[data.selected.fact.value.status] : 'جدول موثق مستقل'}.</p>
        <p className="text-xs text-navy-600">ملاحظات الملف القديم، بلا إثبات سريان: {HR_WORK_STATUS_LABEL[data.legacyObservation.workStatus as keyof typeof HR_WORK_STATUS_LABEL] ?? 'غير معروفة'}؛ الالتحاق <bdi>{data.legacyObservation.hireDate ?? 'غير مسجل'}</bdi>؛ الانتهاء <bdi>{data.legacyObservation.endDate ?? 'غير مسجل'}</bdi>؛ حساب مرتبط {data.legacyObservation.linkedUserId ?? 'لا يوجد'}.</p>
        {facts.length === 0 ? <p>التاريخ غير معروف؛ لا تُستنتج تواريخه من الملف القديم.</p> : <ul className="space-y-2">{facts.map(fact => <li key={fact.id} className="rounded-xl border p-3 text-sm">
          <div dir="ltr">{fact.from} → {fact.to ?? '∞'}</div><div>{'status' in fact.value ? HR_WORK_STATUS_LABEL[fact.value.status] : `${fact.value.timeZone}؛ ${fact.value.segments.length} مقطع؛ أيام ${fact.value.workingDays.map(d => weekdays[d]).join('، ')}`}</div><code className="text-xs">{fact.id}</code>
        </li>)}</ul>}
        <label className="grid gap-1 text-sm">فحص مراجعة مسجلة سابقة<input className={field} type="number" min="0" max={data.headRevision} defaultValue={data.timeline.revision} key={data.timeline.revision} onKeyDown={event => { if (event.key === 'Enter') void load(Number(event.currentTarget.value)); }} onBlur={event => { const revision = Number(event.currentTarget.value); if (Number.isSafeInteger(revision) && revision >= 0 && revision !== data.timeline.revision) void load(revision); }} /></label>
        {data.selectedRecord && !data.records.some(record => record.revision === data.selectedRecord?.revision) && <p className="rounded-xl bg-navy-50 p-3 text-sm">تسجيل المراجعة المختارة: {data.selectedRecord.recordedAt}؛ الفاعل #{data.selectedRecord.actorUserId}؛ السبب: {data.selectedRecord.reason}؛ استبدلت: {data.selectedRecord.supersededIds.join('، ') || 'لا شيء'}؛ أضافت: {data.selectedRecord.appendedIds.join('، ')}</p>}
        <details><summary className="cursor-pointer text-sm font-bold">سجل التسجيل والتصحيح ({data.records.length})</summary><ol className="space-y-2 pt-2">{data.records.map(record => <li key={record.revision} className="rounded-xl bg-navy-50 p-3 text-sm">
          مراجعة {record.revision} بعد {record.previousRevision}؛ حساب الفاعل #{record.actorUserId}<div dir="ltr">{record.recordedAt}</div><p>{record.reason}</p><p>استبدلت: {record.supersededIds.join('، ') || 'لا شيء'}؛ أضافت: {record.appendedIds.join('، ')}</p>
        </li>)}</ol>{data.hasMoreRecords && <p>المعروض أحدث50 تسجيلًا؛ افحص رقم المراجعة المطلوبة أعلاه.</p>}</details>
        {pending && <div role="status" className="rounded-xl bg-blue-50 p-3 text-sm">طلب محفوظ غير محسوم: <code>{pending.requestId}</code>. سيُعاد المحتوى نفسه؛ الحقول مقفلة حتى إيصال مطابق.</div>}
        <form onSubmit={submit} aria-label="توثيق التاريخ" className="space-y-3">
          <fieldset disabled={Boolean(pending) || busy || historicalView} className="space-y-3">
            <label className="grid gap-1 text-sm">نوع التوثيق<select className={field} value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="add">توثيق فترة مستقلة</option><option value="correct">تصحيح فترة موثقة</option><option value="version">نسخة جديدة ابتداءً من تاريخ</option></select></label>
            {mode !== 'add' && <label className="grid gap-1 text-sm">الفترة الأصلية<select className={field} value={originalId} onChange={event => chooseOriginal(event.target.value)}><option value="">اختر الفترة</option>{facts.map(fact => <option key={fact.id} value={fact.id}>{fact.from} → {fact.to ?? 'مفتوحة'}</option>)}</select></label>}
            {mode === 'version' && <p className="text-sm">ستُحفظ الفترة السابقة بقيمها حتى البداية الجديدة، ويُوثق التغيير في مراجعة جديدة بمعرفات جديدة. النهاية تبقى نهاية الفترة الأصلية.</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">بداية السريان<input className={field} type="date" value={from} onChange={event => setFrom(event.target.value)} required /></label><label className="grid gap-1 text-sm">نهاية السريان (غير مشمولة)<input className={field} type="date" readOnly={mode === 'version'} value={mode === 'version' ? original?.to ?? '' : to} onChange={event => setTo(event.target.value)} /></label></div>
            {kind === 'employment' ? <label className="grid gap-1 text-sm">حالة العمل الموثقة<select className={field} value={status} onChange={event => setStatus(event.target.value as typeof status)}>{Object.entries(HR_WORK_STATUS_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label> : <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">المنطقة الزمنية<input className={field} value={zone} onChange={event => setZone(event.target.value)} required /></label><label className="grid gap-1 text-sm">السماح بالدقائق<input className={field} type="number" min="0" max="120" step="1" value={grace} onChange={event => setGrace(event.target.value)} required /></label></div>
              <fieldset><legend className="text-sm">أيام العمل الصريحة</legend><div className="flex flex-wrap gap-3">{weekdays.map((name, day) => <label key={day} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={days.includes(day)} onChange={event => setDays(current => event.target.checked ? [...current, day].sort() : current.filter(d => d !== day))} />{name}</label>)}</div></fieldset>
              {segments.map((segment, index) => <fieldset key={segment.id} className="rounded-xl border p-3"><legend className="text-sm">المقطع {index + 1}</legend><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">بداية المقطع {index + 1}<input className={field} type="time" value={segment.start} onChange={event => updateSegment(index, { start: event.target.value })} required /></label>
                <label className="grid gap-1 text-sm">يوم البداية للمقطع {index + 1}<select className={field} value={segment.startDayOffset} onChange={event => updateSegment(index, { startDayOffset: Number(event.target.value) as 0 | 1 })}><option value="0">يوم المرساة</option><option value="1">اليوم التالي</option></select></label>
                <label className="grid gap-1 text-sm">نهاية المقطع {index + 1}<input className={field} type="time" value={segment.end} onChange={event => updateSegment(index, { end: event.target.value })} required /></label>
                <label className="grid gap-1 text-sm">يوم النهاية للمقطع {index + 1}<select className={field} value={segment.endDayOffset} onChange={event => updateSegment(index, { endDayOffset: Number(event.target.value) as 0 | 1 })}><option value="0">يوم المرساة</option><option value="1">اليوم التالي</option></select></label>
              </div><button type="button" className={`${button} mt-2`} disabled={segments.length === 1} onClick={() => setSegments(current => current.filter((_, i) => i !== index))}>حذف المقطع {index + 1}</button></fieldset>)}
              <button type="button" className={button} disabled={segments.length >= 16} onClick={() => setSegments(current => [...current, { id: `segment-${crypto.randomUUID()}`, start: '16:00', startDayOffset: 0, end: '20:00', endDayOffset: 0 }])}>إضافة مقطع</button>
            </>}
            <label className="grid gap-1 text-sm">سبب التوثيق أو التصحيح<textarea className={field} rows={3} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} required /></label>
          </fieldset>
          <button type="submit" className={`${button} bg-navy-900 text-white`} disabled={busy || (!pending && historicalView)}>{busy ? 'جارٍ التحقق…' : pending ? 'إعادة الطلب المحفوظ للتحقق' : 'توثيق الفترة'}</button>
        </form>
      </>}
    </div>
  </Modal>;
}
