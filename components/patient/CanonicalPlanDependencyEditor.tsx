"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CanonicalPatientCases } from "@/lib/canonical-case-projection";
import { DEPENDENCY_REQUIREMENT_LABEL } from "@/lib/cases";

type Pending = { kind: "add" | "remove"; itemId: number; requiresItemId: number };
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const validPending = (v: unknown): v is Pending => !!v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join(",") === "itemId,kind,requiresItemId" && ["add", "remove"].includes((v as Pending).kind)
  && id((v as Pending).itemId) && id((v as Pending).requiresItemId) && (v as Pending).itemId !== (v as Pending).requiresItemId;
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
const field = "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2";

/** Only a minimal pending marker is stored in the tab, never the clinical note.
 * No mutation is replayed; a refreshed graph and new explicit intent are needed. */
export function CanonicalPlanDependencyEditor({ patientId, ownerKey, feed, refresh }: {
  patientId: string; ownerKey: string; feed: CanonicalPatientCases | null; refresh: () => void;
}) {
  const storageKey = `aqlan.plan-dependency.pending:${encodeURIComponent(ownerKey)}:${patientId}`, formId = useId();
  const [initial] = useState(() => {
    try { const raw = sessionStorage.getItem(storageKey); if (raw === null) return { pending: null, uncertain: false, warning: false };
      let value: unknown; try { value = JSON.parse(raw); } catch { value = null; }
      return { pending: validPending(value) ? value : null, uncertain: true, warning: false };
    } catch { return { pending: null, uncertain: false, warning: true }; }
  });
  const [open, setOpen] = useState(false), [itemId, setItemId] = useState(0), [requiresItemId, setRequiresItemId] = useState(0);
  const [requirement, setRequirement] = useState<"completed" | "clearance">("completed"), [note, setNote] = useState("");
  const [pending, setPending] = useState<Pending | null>(initial.pending), [uncertain, setUncertain] = useState(initial.uncertain);
  const [unverifiedFeed, setUnverifiedFeed] = useState<CanonicalPatientCases | null>(null), [storageWarning, setStorageWarning] = useState(initial.warning);
  const [message, setMessage] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const active = useRef(false), sending = useRef(false), uncertainRef = useRef(initial.uncertain), controller = useRef<AbortController | null>(null);
  // Capture the selected edge version. Refreshing the feed must not silently
  // replace the comparison associated with a user's deletion intent.
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, [storageKey]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (sending.current || uncertainRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, []);
  function erase() { try { sessionStorage.removeItem(storageKey); } catch { setStorageWarning(true); } }
  function resetDraft() { setItemId(0); setRequiresItemId(0); setSelectedVersion(null); setNote(""); setRequirement("completed"); }
  function selectPair(item: number, required: number) {
    setItemId(item); setRequiresItemId(required); setSelectedVersion(feed?.dependencies.find(d => d.itemId === item && d.requiresItemId === required)?.version ?? null); setMessage(null);
  }
  async function send(kind: "add" | "remove") {
    if (!active.current || sending.current || uncertainRef.current || !feed?.planVisible || !id(itemId) || !id(requiresItemId) || itemId === requiresItemId) return;
    if (!feed.items.some(i => i.id === itemId) || !feed.items.some(i => i.id === requiresItemId)) { setMessage("تغيّرت البنود. أغلق التعديل واخترها من جديد."); return; }
    const edge = feed.dependencies.find(d => d.itemId === itemId && d.requiresItemId === requiresItemId);
    if (kind === "remove" && (!selectedVersion || edge?.version !== selectedVersion) || kind === "add" && (edge || selectedVersion !== null)) { setMessage("تغيّر الاعتماد. أغلق التعديل واختر البندين من القراءة الحالية."); return; }
    const marker: Pending = { kind, itemId, requiresItemId };
    sending.current = true; setBusy(true); setPending(marker); setMessage(null); setUnverifiedFeed(feed);
    try { sessionStorage.setItem(storageKey, JSON.stringify(marker)); } catch { setStorageWarning(true); }
    const request = new AbortController(); controller.current = request; const timeout = setTimeout(() => request.abort(), 10_000);
    const unknown = () => { uncertainRef.current = true; setUncertain(true); setOpen(false); resetDraft(); setMessage("لم تتأكد نتيجة تغيير الاعتماد. لن نعيد الطلب تلقائيًا؛ تحقّق من الشبكة الحالية."); refresh(); };
    try {
      const response = await fetch(`/api/plan-items/${itemId}/dependencies`, { method: kind === "add" ? "POST" : "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "add" ? { requiresItemId, requirement, note: note.trim() || null } : { requiresItemId, expectedVersion: selectedVersion }), signal: request.signal });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) {
        if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|plan_dependency_|invalid_plan_dependency$)/.test(String(result.code)))) {
          erase(); setPending(null); setOpen(false); resetDraft(); setMessage(typeof result.message === "string" ? result.message : "لم يُغيّر الاعتماد. راجع السجل الحالي."); refresh();
        } else unknown();
        return;
      }
      if (!result || Object.keys(result).sort().join(",") !== "itemId,ok,requiresItemId" || result.ok !== true || result.itemId !== itemId || result.requiresItemId !== requiresItemId) { unknown(); return; }
      erase(); setPending(null); setOpen(false); resetDraft(); setMessage(kind === "add" ? "أُضيف الاعتماد وسُجّل أثره." : "أُزيل الاعتماد وسُجّل أثره."); refresh();
    } catch { if (active.current) unknown(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  const edge = feed?.dependencies.find(d => d.itemId === itemId && d.requiresItemId === requiresItemId);
  const verified = feed !== null && feed !== unverifiedFeed;
  const present = pending && feed?.dependencies.some(d => d.itemId === pending.itemId && d.requiresItemId === pending.requiresItemId);
  return <div data-testid="canonical-plan-dependency-editor" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    {storageWarning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في هذا التبويب. تجنب إغلاق الصفحة قبل التأكد؛ الاستعادة بعد إعادة التحميل غير مضمونة.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {uncertain ? <div className="space-y-2 rounded-lg bg-amber-50 p-3">
      <p>طلب اعتماد سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.</p>
      <button type="button" className={button} disabled={busy} onClick={() => { setUnverifiedFeed(feed); refresh(); }}>التحقق من الاعتماد الحالي</button>
      {verified && feed ? <><p className="text-xs">{pending ? present ? "الاعتماد موجود في القراءة الحالية." : "الاعتماد غير موجود في القراءة الحالية." : "راجع شبكة الاعتماديات الحالية."} هذه قراءة للحالة، وليست إثباتًا لطلب بعينه.</p>
        <button type="button" className={button} onClick={() => { if (!active.current || sending.current || !feed) return; erase(); setPending(null); uncertainRef.current = false; setUncertain(false); setUnverifiedFeed(null); resetDraft(); setOpen(true); setMessage(null); }}>راجعت الاعتماد الحالي، بدء طلب جديد</button></> : null}
    </div> : !open ? <button type="button" className={button} disabled={busy || !feed?.planVisible} onClick={() => { resetDraft(); setOpen(true); setMessage(null); }}>إدارة اعتماديات البنود</button> : feed ? <div className="space-y-3">
      <p className="text-xs text-slate-600">الاعتماد يوضح ترتيب العلاج؛ يبقى تنبيهًا سريريًا ولا يغيّر الفواتير أو يمنع التنفيذ تلقائيًا.</p>
      <div><label htmlFor={`${formId}-item`} className="block text-xs font-bold">البند الذي يحتاج متطلبًا</label><select id={`${formId}-item`} className={field} disabled={busy} value={itemId || ""} onChange={e => selectPair(Number(e.target.value), 0)}><option value="">اختر البند</option>{feed.items.map(i => <option key={i.id} value={i.id}>{i.serviceName} — {i.planTitle}</option>)}</select></div>
      <div><label htmlFor={`${formId}-required`} className="block text-xs font-bold">البند المطلوب قبله</label><select id={`${formId}-required`} className={field} disabled={busy || !itemId} value={requiresItemId || ""} onChange={e => selectPair(itemId, Number(e.target.value))}><option value="">اختر المتطلب</option>{feed.items.filter(i => i.id !== itemId).map(i => <option key={i.id} value={i.id}>{i.serviceName} — {i.planTitle}</option>)}</select></div>
      {edge ? <div className="space-y-2"><p>الاعتماد الحالي: {DEPENDENCY_REQUIREMENT_LABEL[edge.requirement]} · {edge.met ? "متحقق" : "لم يتحقق"}</p>{edge.note ? <p className="whitespace-pre-wrap">{edge.note}</p> : null}
        <button type="button" className={button} disabled={busy} onClick={() => void send("remove")}>إزالة الاعتماد المحدد</button></div> : <>
        <div><label htmlFor={`${formId}-requirement`} className="block text-xs font-bold">شرط المتطلب</label><select id={`${formId}-requirement`} className={field} disabled={busy} value={requirement} onChange={e => setRequirement(e.target.value as "completed" | "clearance")}><option value="completed">{DEPENDENCY_REQUIREMENT_LABEL.completed}</option><option value="clearance">{DEPENDENCY_REQUIREMENT_LABEL.clearance}</option></select></div>
        <div><label htmlFor={`${formId}-note`} className="block text-xs font-bold">ملاحظة الاعتماد</label><textarea id={`${formId}-note`} className={field} maxLength={500} disabled={busy} value={note} onChange={e => setNote(e.target.value)} /></div>
        <button type="button" className={button} disabled={busy || !itemId || !requiresItemId} onClick={() => void send("add")}>إضافة الاعتماد</button>
      </>}
      <button type="button" className={button} disabled={busy} onClick={() => { resetDraft(); setOpen(false); setMessage(null); }}>إلغاء تحرير الاعتماد</button>
    </div> : <p role="status">تحقق من القراءة الحالية قبل متابعة الاعتماد.</p>}
  </div>;
}
