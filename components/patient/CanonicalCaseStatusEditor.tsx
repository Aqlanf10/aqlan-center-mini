"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CanonicalPatientCases } from "@/lib/canonical-case-projection";
import { CASE_STATUSES, CASE_STATUS_LABEL, canMoveCase, type CaseStatus } from "@/lib/cases";

type Draft = { caseId: number; version: string; status: CaseStatus; outcome: string };
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
const field = "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2";

/** Pending recovery stores only the case ID, never the clinical outcome. */
export function CanonicalCaseStatusEditor({ patientId, ownerKey, feed, refresh }: {
  patientId: string; ownerKey: string; feed: CanonicalPatientCases | null; refresh: () => void;
}) {
  const storageKey = `aqlan.case-status.pending:${encodeURIComponent(ownerKey)}:${patientId}`, formId = useId();
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
    const current = feed.cases.find(c => c.id === draft.caseId && c.kind === "specialty");
    if (!current || current.version !== draft.version) { setMessage("تغيّرت الحالة أثناء التحرير. أغلق التعديل واخترها من جديد."); return; }
    if (!canMoveCase(current.status, draft.status) || draft.outcome.length > 2000 || draft.status === "cancelled" && !draft.outcome.trim()) { setMessage("اختر انتقالًا متاحًا، واكتب سببًا عند الإلغاء."); return; }
    const request = new AbortController(); controller.current = request;
    sending.current = true; setBusy(true); setPending(draft.caseId); setUnverifiedFeed(feed); setMessage(null);
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft.caseId)); } catch { setStorageWarning(true); }
    const timeout = setTimeout(() => request.abort(), 10_000);
    const unknown = () => { uncertainRef.current = true; setUncertain(true); setDraft(null); setOpen(false); setMessage("لم تتأكد نتيجة تغيير الحالة. لن نعيد الطلب تلقائيًا؛ راجع السجل الحالي."); refresh(); };
    try {
      const response = await fetch(`/api/cases/${draft.caseId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: draft.status, outcome: draft.outcome.trim() || null, expectedVersion: draft.version }), signal: request.signal });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) {
        if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|case_status_|invalid_case_status$)/.test(String(result.code)))) {
          erase(); setPending(null); setOpen(false); setDraft(null); setMessage(typeof result.message === "string" ? result.message : "لم تتغيّر الحالة. راجع السجل الحالي."); refresh();
        } else unknown();
        return;
      }
      if (!result || Object.keys(result).sort().join(",") !== "caseId,ok,status" || result.ok !== true || result.caseId !== draft.caseId || result.status !== draft.status) { unknown(); return; }
      erase(); setPending(null); setOpen(false); setDraft(null); setMessage("حُفظت حالة العلاج ونتيجتها وسُجّل الأثر."); refresh();
    } catch { if (active.current) unknown(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  const selected = draft && feed?.cases.find(c => c.id === draft.caseId && c.kind === "specialty");
  const currentPending = pending && feed?.cases.find(c => c.id === pending && c.kind === "specialty");
  const editable = feed?.cases.filter(c => c.kind === "specialty" && c.id !== null && c.version !== null && CASE_STATUSES.some(to => canMoveCase(c.status, to))) ?? [];
  const verified = feed !== null && feed !== unverifiedFeed;
  return <div data-testid="canonical-case-status-editor" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    {storageWarning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في هذا التبويب. تجنب إغلاق الصفحة قبل التأكد؛ الاستعادة بعد إعادة التحميل غير مضمونة.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {uncertain ? <div className="space-y-2 rounded-lg bg-amber-50 p-3">
      <p>طلب تغيير حالة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.</p>
      <button type="button" className={button} disabled={busy} onClick={() => { setUnverifiedFeed(feed); refresh(); }}>التحقق من حالة العلاج الحالية</button>
      {verified && feed ? <><p className="text-xs">{currentPending ? `حالة العلاج الحالية: ${CASE_STATUS_LABEL[currentPending.status]}.` : "راجع الحالات المتاحة في القراءة الحالية."} هذه قراءة للسجل، وليست إثباتًا لطلب بعينه.</p>
        <button type="button" className={button} onClick={() => { if (!active.current || sending.current || !feed) return; erase(); setPending(null); uncertainRef.current = false; setUncertain(false); setUnverifiedFeed(null); setDraft(null); setOpen(true); setMessage(null); }}>راجعت حالة العلاج، بدء تعديل جديد</button></> : null}
    </div> : !open ? <button type="button" className={button} disabled={busy || !feed?.planVisible} onClick={() => { setOpen(true); setDraft(null); setMessage(null); }}>تغيير حالة العلاج</button> : feed ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
      <p className="text-xs text-slate-600">الحالة المنتهية لا تُعاد فتحها. حالة التقويم المرتبطة تُدار من وحدة التقويم.</p>
      <div><label htmlFor={`${formId}-case`} className="block text-xs font-bold">الحالة المراد تحديثها</label><select id={`${formId}-case`} className={field} disabled={busy} value={draft?.caseId ?? ""} onChange={e => {
        const row = editable.find(c => c.id === Number(e.target.value)), next = row && CASE_STATUSES.find(to => canMoveCase(row.status, to));
        setDraft(row?.id && row.version && next ? { caseId: row.id, version: row.version, status: next, outcome: row.outcome ?? "" } : null); setMessage(null);
      }}><option value="">اختر الحالة</option>{editable.map(c => <option key={c.id} value={c.id!}>{c.title} — {CASE_STATUS_LABEL[c.status]}</option>)}</select></div>
      {!editable.length ? <p>لا توجد حالة متاحة للانتقال من هذا العرض.</p> : null}
      {draft && selected ? <>
        <div><label htmlFor={`${formId}-status`} className="block text-xs font-bold">الحالة الجديدة للعلاج</label><select id={`${formId}-status`} className={field} disabled={busy} value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value as CaseStatus })}>{CASE_STATUSES.filter(to => canMoveCase(selected.status, to)).map(to => <option key={to} value={to}>{CASE_STATUS_LABEL[to]}</option>)}</select></div>
        <div><label htmlFor={`${formId}-outcome`} className="block text-xs font-bold">نتيجة العلاج أو سبب الإلغاء</label><textarea id={`${formId}-outcome`} className={field} maxLength={2000} disabled={busy} value={draft.outcome} onChange={e => setDraft({ ...draft, outcome: e.target.value })} /></div>
        <p className="text-xs text-slate-600">السبب مطلوب عند الإلغاء. ترك النتيجة فارغة يحفظ النتيجة السابقة إن وُجدت.</p>
      </> : null}
      <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy || !draft}>{busy ? "جارٍ الحفظ…" : "حفظ حالة العلاج"}</button><button type="button" className={button} disabled={busy} onClick={() => { setOpen(false); setDraft(null); setMessage(null); }}>إلغاء تحرير الحالة</button></div>
    </form> : <p role="status">تحقق من القراءة الحالية قبل متابعة الحالة.</p>}
  </div>;
}
