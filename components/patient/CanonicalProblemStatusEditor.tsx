"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CanonicalPatientCases } from "@/lib/canonical-case-projection";
import { PROBLEM_STATUSES, PROBLEM_STATUS_LABEL, type ProblemStatus } from "@/lib/cases";

type Draft = { problemId: number; version: string; status: ProblemStatus };
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
const field = "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2";

/** Pending recovery stores only the problem ID, never clinical text. */
export function CanonicalProblemStatusEditor({ patientId, ownerKey, feed, refresh }: {
  patientId: string; ownerKey: string; feed: CanonicalPatientCases | null; refresh: () => void;
}) {
  const storageKey = `aqlan.problem-status.pending:${encodeURIComponent(ownerKey)}:${patientId}`, formId = useId();
  const [initial] = useState(() => {
    try { const raw = sessionStorage.getItem(storageKey); if (raw === null) return { pending: null, uncertain: false, warning: false };
      let value: unknown; try { value = JSON.parse(raw); } catch { value = null; }
      return { pending: id(value) ? value : null, uncertain: true, warning: false };
    } catch { return { pending: null, uncertain: false, warning: true }; }
  });
  const [pending, setPending] = useState<number | null>(initial.pending), [uncertain, setUncertain] = useState(initial.uncertain);
  const [open, setOpen] = useState(false), [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null), [storageWarning, setStorageWarning] = useState(initial.warning);
  const [unverifiedFeed, setUnverifiedFeed] = useState<CanonicalPatientCases | null>(null);
  const active = useRef(false), sending = useRef(false), uncertainRef = useRef(initial.uncertain), controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, [storageKey]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (sending.current || uncertainRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, []);
  function erase() { try { sessionStorage.removeItem(storageKey); } catch { setStorageWarning(true); } }
  async function save() {
    if (!active.current || sending.current || uncertainRef.current || !draft || !feed) return;
    const current = feed.problems.find(c => c.id === draft.problemId);
    if (!current || current.version !== draft.version) { setMessage("تغيّرت الحالة أثناء التحرير. أغلق التعديل واخترها من جديد."); return; }
    if (current.status === draft.status) { setMessage("اختر حالة مختلفة للمشكلة."); return; }
    const request = new AbortController(); controller.current = request;
    sending.current = true; setBusy(true); setPending(draft.problemId); setUnverifiedFeed(feed); setMessage(null);
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft.problemId)); } catch { setStorageWarning(true); }
    const timeout = setTimeout(() => request.abort(), 10_000);
    const unknown = () => { uncertainRef.current = true; setUncertain(true); setDraft(null); setOpen(false); setMessage("لم تتأكد نتيجة تغيير الحالة. لن نعيد الطلب تلقائيًا؛ راجع السجل الحالي."); refresh(); };
    try {
      const response = await fetch(`/api/problems/${draft.problemId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: draft.status, expectedVersion: draft.version }), signal: request.signal });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) {
        if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|problem_status_|invalid_problem_status$)/.test(String(result.code)))) {
          erase(); setPending(null); setOpen(false); setDraft(null); setMessage(typeof result.message === "string" ? result.message : "لم تتغيّر الحالة. راجع السجل الحالي."); refresh();
        } else unknown();
        return;
      }
      if (!result || Object.keys(result).sort().join(",") !== "ok,problemId,status" || result.ok !== true || result.problemId !== draft.problemId || result.status !== draft.status) { unknown(); return; }
      erase(); setPending(null); setOpen(false); setDraft(null); setMessage("حُفظت حالة المشكلة وسُجّل الأثر."); refresh();
    } catch { if (active.current) unknown(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  const selected = draft && feed?.problems.find(c => c.id === draft.problemId);
  const currentPending = pending && feed?.problems.find(c => c.id === pending);
  const editable = feed?.problems ?? [];
  const verified = feed !== null && feed !== unverifiedFeed;
  return <div data-testid="canonical-problem-status-editor" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    {storageWarning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في هذا التبويب. تجنب إغلاق الصفحة قبل التأكد؛ الاستعادة بعد إعادة التحميل غير مضمونة.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {uncertain ? <div className="space-y-2 rounded-lg bg-amber-50 p-3">
      <p>طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.</p>
      <button type="button" className={button} disabled={busy} onClick={() => { setUnverifiedFeed(feed); refresh(); }}>التحقق من حالة المشكلة الحالية</button>
      {verified && feed ? <><p className="text-xs">{currentPending ? `حالة المشكلة الحالية: ${PROBLEM_STATUS_LABEL[currentPending.status]}.` : "راجع المشاكل المتاحة في القراءة الحالية."} هذه قراءة للسجل، وليست إثباتًا لطلب بعينه.</p>
        <button type="button" className={button} onClick={() => { if (!active.current || sending.current || !feed) return; erase(); setPending(null); uncertainRef.current = false; setUncertain(false); setUnverifiedFeed(null); setDraft(null); setOpen(true); setMessage(null); }}>راجعت حالة المشكلة، بدء تعديل جديد</button></> : null}
    </div> : !open ? <button type="button" className={button} disabled={busy || !feed} onClick={() => { setOpen(true); setDraft(null); setMessage(null); }}>تغيير حالة المشكلة</button> : feed ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
      <p className="text-xs text-slate-600">تغيير حالة المشكلة يُسجّل باسم المستخدم الحالي. حلّ المشكلة لا يغلق الحالة العلاجية المرتبطة.</p>
      <div><label htmlFor={`${formId}-case`} className="block text-xs font-bold">المشكلة المراد تحديثها</label><select id={`${formId}-case`} className={field} disabled={busy} value={draft?.problemId ?? ""} onChange={e => {
        const row = editable.find(c => c.id === Number(e.target.value)), next = row && PROBLEM_STATUSES.find(to => row.status !== to);
        setDraft(row?.id && row.version && next ? { problemId: row.id, version: row.version, status: next } : null); setMessage(null);
      }}><option value="">اختر المشكلة</option>{editable.map(c => <option key={c.id} value={c.id!}>{c.label} — {PROBLEM_STATUS_LABEL[c.status]}</option>)}</select></div>
      {!editable.length ? <p>لا توجد مشكلة متاحة للتحديث من هذا العرض.</p> : null}
      {draft && selected ? <>
        <div><label htmlFor={`${formId}-status`} className="block text-xs font-bold">الحالة الجديدة للمشكلة</label><select id={`${formId}-status`} className={field} disabled={busy} value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as ProblemStatus })}>{PROBLEM_STATUSES.filter(to => selected.status !== to).map(to => <option key={to} value={to}>{PROBLEM_STATUS_LABEL[to]}</option>)}</select></div>
      </> : null}
      <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy || !draft}>{busy ? "جارٍ الحفظ…" : "حفظ حالة المشكلة"}</button><button type="button" className={button} disabled={busy} onClick={() => { setOpen(false); setDraft(null); setMessage(null); }}>إلغاء تحرير المشكلة</button></div>
    </form> : <p role="status">تحقق من القراءة الحالية قبل متابعة الحالة.</p>}
  </div>;
}
