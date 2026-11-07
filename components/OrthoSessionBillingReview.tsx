'use client';
import { useEffect, useState } from 'react';
import { readSessionBillingReview } from '@/lib/ortho-session-billing-review-contract';
import type { BillingClassification } from '@/lib/billing-classification';
interface ViewOwner { active: boolean; denied: boolean; clinical: boolean; readSequence: number; deny(): void }
interface Props { owner: ViewOwner; readVersion: number; patientId: number; orthoCaseId: number; actorId: number; expectedAccess: 'clinical' | 'clinical_financial' }
const classes: Record<BillingClassification, string> = { INCLUDED: 'مشمولة وفق التصنيف المسجل', LEGACY_INCLUDED: 'مشمولة ضمن علاج سابق وفق التصنيف المسجل', NEW_BILLABLE: 'قابلة للفوترة وفق التصنيف المسجل', OUTSIDE_CONTRACT: 'خارج الاتفاق وفق التصنيف المسجل', NO_CHARGE: 'بلا رسوم وفق التصنيف المسجل' };
const valid = (p: Props) => p.owner.active && !p.owner.denied && p.owner.clinical && p.owner.readSequence === p.readVersion;
export default function OrthoSessionBillingReview(props: Props) {
  const [open, setOpen] = useState(false);
  if (!valid(props)) return null;
  return <section className="mt-2 min-w-0 rounded border border-slate-200 p-3 text-xs" aria-label="مراجعة قرارات فوترة جلسات الحالة">
    <button type="button" className="min-h-11 font-bold" aria-expanded={open} onClick={() => { if (valid(props)) setOpen(value => !value); }}>{open ? 'إغلاق مراجعة قرارات الجلسات' : 'مراجعة قرارات فوترة جلسات هذه الحالة'}</button>
    {open && <SessionBillingRead {...props} />}
  </section>;
}
export function SessionBillingRead(props: Props) {
  const { owner, readVersion, patientId, orthoCaseId, actorId, expectedAccess } = props;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([patientId, orthoCaseId, actorId, readVersion, expectedAccess, attempt]);
  const [stored, setStored] = useState<{ owner: ViewOwner; key: string; value: ReturnType<typeof readSessionBillingReview> } | null>(null);
  const [failure, setFailure] = useState<{ owner: ViewOwner; key: string } | null>(null);
  const permitted = valid(props);
  useEffect(() => {
    let alive = true; const controller = new AbortController();
    const current = () => alive && owner.active && !owner.denied && owner.clinical && owner.readSequence === readVersion;
    const accept = () => current() && !controller.signal.aborted;
    setStored(null); setFailure(null);
    const timer = setTimeout(() => { controller.abort(); if (current()) { setStored(null); setFailure({ owner, key }); } }, 15000);
    void (async () => {
      try {
        if (!accept()) return;
        const response = await fetch(`/api/patients/${patientId}/ortho-billing-decisions?orthoCaseId=${orthoCaseId}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: controller.signal });
        if (!accept()) return;
        if ([401,403].includes(response.status)) { owner.deny(); throw Error('denied'); }
        const policies = (response.headers.get('cache-control') ?? '').split(',').map(s => s.trim().toLowerCase());
        if (response.status !== 200 || response.redirected || !policies.includes('private') || !policies.includes('no-store') || policies.includes('public')) throw Error('response');
        const reader = response.body?.getReader(); if (!reader) throw Error('body');
        const chunks: Uint8Array[] = []; let size = 0;
        const abort = () => { void reader.cancel().catch(() => {}); }; controller.signal.addEventListener('abort', abort, { once: true });
        try { while (true) { const part = await reader.read(); if (!accept()) return; if (part.done) break; size += part.value.byteLength; if (size > 2 * 1024 * 1024) throw Error('limit'); chunks.push(part.value); } }
        finally { controller.signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const value = readSessionBillingReview(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), { patientId, orthoCaseId, actorId, access: expectedAccess });
        if (value.access !== expectedAccess) throw Error('projection');
        if (accept()) setStored({ owner, key, value });
      } catch { if (current()) { setStored(null); setFailure({ owner, key }); } }
      finally { clearTimeout(timer); }
    })();
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [owner, readVersion, patientId, orthoCaseId, actorId, expectedAccess, key, permitted]);
  if (!permitted) return null;
  const value = stored?.owner === owner && stored.key === key ? stored.value : null;
  return <div className="space-y-3">
    <p>قراءة حالية للتصنيف والقرار المسجلين، وليست سجلاً تاريخياً كاملاً. قد يُعاد فتح القرار بعد إلغاء فاتورته. لا يُستنتج شمول العلاج من الخطة الحالية، و«فوتِرت» لا تعني «سُددت».</p>
    <button type="button" className="min-h-11 rounded border px-3" onClick={() => { if (valid(props)) { setStored(null); setAttempt(v => v + 1); } }}>تحديث المراجعة</button>
    {failure?.owner === owner && failure.key === key ? <p role="alert">تعذرت مراجعة قرارات الجلسات أو تغيرت الصلاحية. لم يُعتبر السجل فارغاً ولم تُعرض نسخة سابقة.</p> : !value ? <p role="status">جارٍ التحقق من قرارات الجلسات…</p> : <>
      <p>وقت القراءة: <bdi dir="ltr">{value.generatedAt}</bdi></p>
      {!value.entries.length && <p>لا توجد قيود جلسات في هذه القراءة؛ لا يثبت ذلك عدم وجود تعاملات مالية سابقة.</p>}
      {value.entries.map(entry => <article key={entry.id} className="min-w-0 space-y-1 rounded border bg-white p-3">
        <h4 className="font-bold">قيد الجلسة #{entry.id} · <bdi dir="ltr">{entry.doneOn}</bdi></h4>
        <p>التصنيف المسجل للجلسة: {entry.recordedClass === null ? 'غير مسجل؛ لا يُفترض الشمول أو السداد' : classes[entry.recordedClass]}</p>
        <p>القرار الحالي: {entry.decision === 'billed' ? 'فوتِرت؛ هذا ليس إثبات تحصيل' : entry.decision === 'no_charge' ? 'بلا رسوم وفق القرار المسجل' : entry.recordedClass === 'OUTSIDE_CONTRACT' ? 'بانتظار قرار حالياً؛ لا ينفي قراراً سابقاً' : 'لا يوجد قرار حالي مسجل؛ لا ينفي قراراً سابقاً'}</p>
        <p className="whitespace-pre-wrap break-words">السبب: {entry.reasonRestricted ? 'محجوب حسب الصلاحية؛ لا يمكن تحديد وجوده هنا' : entry.reason ?? 'غير مسجل'}</p>
        <p>سجّل القرار: {entry.decidedBy ?? 'غير مسجل'} · وقت القرار: <bdi dir="ltr">{entry.decidedAt ?? 'غير مسجل'}</bdi></p>
        <p>مرجع الفاتورة: {entry.invoice.state === 'restricted' ? 'محجوب حسب الصلاحية؛ لا يمكن تأكيد حالته هنا' : entry.invoice.state === 'none' ? 'لا يوجد مرجع حالي مسجل؛ لا ينفي مرجعاً سابقاً' : entry.invoice.state === 'missing' ? 'مرجع غير محلول؛ لا يُفترض عدم وجود فاتورة' : 'id' in entry.invoice ? <><bdi dir="ltr">{entry.invoice.number}</bdi> · #{entry.invoice.id} · {entry.invoice.state === 'cancelled' ? 'ملغاة وفق القراءة الحالية' : 'قائمة وفق القراءة الحالية؛ لا يثبت ذلك السداد'}</> : 'تعذر التحقق من المرجع'}</p>
      </article>)}
    </>}
  </div>;
}
