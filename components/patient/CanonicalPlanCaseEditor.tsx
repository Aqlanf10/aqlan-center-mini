"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CanonicalPatientCases } from "@/lib/canonical-case-projection";

interface Intent { itemId: number; caseId: number | null; priority: number | null; expectedCaseId: number | null; expectedPriority: number | null }
type Draft = { itemId: number; caseId: string; priority: string; expectedCaseId: number | null; expectedPriority: number | null };
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
function validIntent(v: unknown): v is Intent {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Intent;
  return Object.keys(r).sort().join(",") === "caseId,expectedCaseId,expectedPriority,itemId,priority" && positive(r.itemId)
    && [r.caseId, r.expectedCaseId].every(id => id === null || positive(id))
    && [r.priority, r.expectedPriority].every(n => n === null || positive(n) && n <= 999);
}
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";

/** A tab-local pending intent, not a durable request receipt. No replay after a lost
 * response: re-read the record, then explicitly start a fresh comparison/intent. */
export function CanonicalPlanCaseEditor({ patientId, ownerKey, feed, refresh }: {
  patientId: string; ownerKey: string; feed: CanonicalPatientCases | null; refresh: () => void;
}) {
  const storageKey = `aqlan.plan-case.pending:${encodeURIComponent(ownerKey)}:${patientId}`;
  const formId = useId();
  // The parent mounts this workspace only after the user opens its client panel.
  // Restore once at mount, before enabling an edit; no effect copies state on each read.
  const [initial] = useState(() => {
    try { const raw = sessionStorage.getItem(storageKey); if (raw === null) return { pending: null, uncertain: false, warning: false };
      let restored: unknown; try { restored = JSON.parse(raw); } catch { restored = null; }
      return { pending: validIntent(restored) ? restored : null, uncertain: true, warning: false };
    } catch { return { pending: null, uncertain: false, warning: true }; }
  });
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null), [pending, setPending] = useState<Intent | null>(initial.pending);
  const [uncertain, setUncertain] = useState(initial.uncertain), [unverifiedFeed, setUnverifiedFeed] = useState<CanonicalPatientCases | null>(null);
  const [message, setMessage] = useState<string | null>(null), [storageWarning, setStorageWarning] = useState(initial.warning);
  const active = useRef(false), sending = useRef(false), controller = useRef<AbortController | null>(null), uncertainRef = useRef(initial.uncertain);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; controller.current?.abort(); };
  }, [storageKey]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (sending.current || uncertainRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, []);
  function erasePending() { try { sessionStorage.removeItem(storageKey); } catch { setStorageWarning(true); } }
  async function save() {
    if (!active.current || sending.current || uncertainRef.current || !feed || !draft) return;
    const current = feed.items.find(i => i.id === draft.itemId);
    if (!current || current.caseId !== draft.expectedCaseId || current.priority !== draft.expectedPriority) { setMessage("تغيّر البند أثناء التحرير. أغلق التعديل واختر البند من جديد."); return; }
    const intent: Intent = { itemId: draft.itemId, caseId: draft.caseId === "" ? null : Number(draft.caseId), priority: draft.priority === "" ? null : Number(draft.priority), expectedCaseId: draft.expectedCaseId, expectedPriority: draft.expectedPriority };
    if (!validIntent(intent)) { setMessage("الأولوية رقم من 1 إلى 999، أو اتركها فارغة."); return; }
    sending.current = true; setBusy(true); setMessage(null); setPending(intent); setUnverifiedFeed(feed);
    try { sessionStorage.setItem(storageKey, JSON.stringify(intent)); } catch { setStorageWarning(true); }
    const request = new AbortController(); controller.current = request; const timeout = setTimeout(() => request.abort(), 10_000);
    const unknown = () => { uncertainRef.current = true; setUncertain(true); setDraft(null); setOpen(false); setMessage("لم تتأكد نتيجة الحفظ. لن نعيد الطلب تلقائيًا؛ حدّث السجل وراجع الحالة الحالية."); refresh(); };
    try {
      const response = await fetch(`/api/plan-items/${intent.itemId}/case`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseId: intent.caseId, priority: intent.priority, expectedCaseId: intent.expectedCaseId, expectedPriority: intent.expectedPriority }), signal: request.signal });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) {
        if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|plan_case_|plan_item_not_found$|invalid_plan_case$)/.test(String(result.code)))) {
          erasePending(); setPending(null); setDraft(null); setOpen(false); setMessage(typeof result.message === "string" ? result.message : "لم يُحفظ الربط. راجع الحالة الحالية."); refresh();
        } else unknown();
        return;
      }
      if (!result || Object.keys(result).sort().join(",") !== "caseId,changed,itemId,ok,priority" || result.ok !== true || typeof result.changed !== "boolean"
        || result.itemId !== intent.itemId || result.caseId !== intent.caseId || result.priority !== intent.priority) { unknown(); return; }
      erasePending(); setPending(null); setDraft(null); setOpen(false); setMessage(result.changed ? "حُفظ ربط البند وأولويته." : "القيم الحالية مطابقة؛ لم يُسجّل تعديل إضافي."); refresh();
    } catch { if (active.current) unknown(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  const matched = pending && feed?.items.some(i => i.id === pending.itemId && i.caseId === pending.caseId && i.priority === pending.priority);
  const verified = feed !== null && feed !== unverifiedFeed;
  return <div data-testid="canonical-plan-case-editor" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    {storageWarning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في هذا التبويب. تجنب إغلاق الصفحة قبل التأكد من نتيجة الحفظ؛ الاستعادة بعد إعادة التحميل غير مضمونة.</p> : null}
    {message ? <p role="status" className="text-sm text-navy-800">{message}</p> : null}
    {uncertain ? <div className="space-y-2 rounded-lg bg-amber-50 p-3">
      <p>طلب حفظ سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.</p>
      <button type="button" className={button} disabled={busy} onClick={() => { setUnverifiedFeed(feed); refresh(); }}>التحقق من الحالة الحالية</button>
      {verified && feed ? <><p className="text-xs">{matched ? "الحالة الحالية تطابق التعديل المطلوب. هذا يثبت القيم الحالية، ولا يثبت أي طلب بعينه." : "راجع الربط والأولوية المعروضين الآن قبل أي تعديل جديد."}</p>
        <button type="button" className={button} onClick={() => { if (!active.current || sending.current || !feed) return; erasePending(); setPending(null); uncertainRef.current = false; setUncertain(false); setUnverifiedFeed(null); setDraft(null); setOpen(true); setMessage(null); }}>راجعت الحالة الحالية، بدء تعديل جديد</button></> : null}
    </div> : !open ? <button type="button" className={button} disabled={busy || !feed?.planVisible} onClick={() => { setOpen(true); setDraft(null); setMessage(null); }}>تعديل ربط بند وأولويته</button> : feed ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div><label htmlFor={`${formId}-item`} className="block text-xs font-bold">بند الخطة</label><select id={`${formId}-item`} className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2" disabled={busy} value={draft?.itemId ?? ""} onChange={event => {
        const item = feed.items.find(i => i.id === Number(event.target.value)); setDraft(item ? { itemId: item.id, caseId: item.caseId === null ? "" : String(item.caseId), priority: item.priority === null ? "" : String(item.priority), expectedCaseId: item.caseId, expectedPriority: item.priority } : null); setMessage(null);
      }}><option value="">اختر البند</option>{feed.items.map(i => <option key={i.id} value={i.id}>{i.serviceName} — {i.planTitle}</option>)}</select></div>
      {draft ? <>
        <div><label htmlFor={`${formId}-case`} className="block text-xs font-bold">الحالة المرتبطة</label><select id={`${formId}-case`} className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2" disabled={busy} value={draft.caseId} onChange={event => setDraft({ ...draft, caseId: event.target.value })}>
          <option value="">بلا حالة مرتبطة</option>{feed.cases.filter(c => c.kind === "specialty" && c.id !== null).map(c => <option key={c.id} value={c.id!}>{c.title}</option>)}
        </select></div>
        <div><label htmlFor={`${formId}-priority`} className="block text-xs font-bold">أولوية البند</label><input id={`${formId}-priority`} type="number" min={1} max={999} step={1} className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 p-2" value={draft.priority} disabled={busy} onChange={event => setDraft({ ...draft, priority: event.target.value })} /></div>
        <p className="text-xs text-slate-600">الأصغر أولًا. إذا احتفظ البند بمصدر فاتورة أو اتفاق تاريخي، تبقى الحالة ثابتة ويمكن تعديل الأولوية فقط.</p>
      </> : null}
      <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={!draft || busy}>{busy ? "جارٍ الحفظ…" : "حفظ الربط والأولوية"}</button>
        <button type="button" className={button} disabled={busy} onClick={() => { setOpen(false); setDraft(null); setMessage(null); }}>إلغاء التعديل</button></div>
    </form> : <p role="status" className="text-xs">تحقق من القراءة الحالية قبل متابعة التعديل.</p>}
  </div>;
}
