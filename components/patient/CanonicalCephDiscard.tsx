"use client";
import { formatClinicDate } from "@/lib/clinic-clock";
import { useEffect, useId, useRef, useState } from "react";
import { isCanonicalCephStudy, type CanonicalCephStudy } from "@/lib/canonical-ceph-projection";

const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Mounted at list level so an unknown discard remains visible after its draft disappears. */
export function CanonicalCephDiscard({ patientId, ownerKey, draftId, refresh, onDiscarded }: {
  patientId: string; ownerKey: string; draftId: number | null; refresh: () => void; onDiscarded: () => void;
}) {
  const storageKey = `aqlan.ceph-discard.pending:${encodeURIComponent(ownerKey)}:${patientId}`, noteId = useId();
  const [initial] = useState(() => { try {
    const raw = sessionStorage.getItem(storageKey); if (raw === null) return { pending: false, id: null, warning: false };
    let value: unknown; try { value = JSON.parse(raw); } catch { value = null; }
    return { pending: true, id: validId(value) ? value : null, warning: false };
  } catch { return { pending: false, id: null, warning: true }; } });
  const [pending, setPending] = useState(initial.pending), [pendingId, setPendingId] = useState<number | null>(initial.id);
  const [warning, setWarning] = useState(initial.warning), [busy, setBusy] = useState(false);
  const [observed, setObserved] = useState<CanonicalCephStudy | null>(null), [note, setNote] = useState("");
  const [checked, setChecked] = useState(false), [message, setMessage] = useState<string | null>(null);
  const active = useRef(false), sending = useRef(false), pendingRef = useRef(initial.pending), controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, [storageKey]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (sending.current || pendingRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, []);
  const erase = () => { try { sessionStorage.removeItem(storageKey); } catch { setWarning(true); } };
  async function inspect(recovery: boolean) {
    if (!active.current || sending.current) return;
    const id = recovery ? pendingId : draftId;
    if (!validId(id)) { setMessage("تعذّر تحديد الطلب السابق. راجع السجل الحالي؛ لم يُرسل طلب رفض."); return; }
    sending.current = true; setBusy(true); setObserved(null); setNote(""); setChecked(false); setMessage(null);
    const request = new AbortController(); controller.current = request;
    const timeout = setTimeout(() => request.abort(), 8000);
    try {
      const response = await fetch(`/api/ceph/${id}`, { cache: "no-store", signal: request.signal });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (recovery && response.status === 404) { setChecked(true); setMessage("المسودة غير متاحة في القراءة الحالية. هذا لا يثبت نتيجة طلب بعينه؛ راجع السجل قبل إغلاق المتابعة."); return; }
      if (!response.ok || !isCanonicalCephStudy(result, Number(patientId), id)) {
        if (response.status === 401 || response.status === 403) refresh();
        throw new Error("تعذّر التحقق من المسودة الحالية. لم يُرسل طلب رفض.");
      }
      if (recovery) { setChecked(true); setMessage(result.analysis.status === "draft" ? "المسودة ما زالت حالية. راجعها؛ أي طلب جديد يحتاج نية وتأكيدًا جديدين." : "الدراسة معتمدة الآن ولا يمكن رفضها. القراءة الحالية ليست إيصالًا لطلب بعينه."); return; }
      if (result.analysis.status !== "draft" || typeof result.discardVersion !== "string") throw new Error("لم تعد هذه مسودة متاحة للرفض. حدّث الدراسات.");
      setObserved(result);
    } catch (error) { if (active.current) setMessage(error instanceof Error && error.name === "Error" ? error.message : "تعذّر التحقق من المسودة الحالية. لم يُرسل طلب رفض."); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  async function discard() {
    if (!active.current || sending.current || pendingRef.current || !observed || observed.analysis.id !== draftId || !observed.discardVersion) return;
    const id = observed.analysis.id;
    sending.current = true; setBusy(true); setMessage(null); setChecked(false); setPendingId(id);
    try { sessionStorage.setItem(storageKey, JSON.stringify(id)); } catch { setWarning(true); }
    const request = new AbortController(); controller.current = request;
    const timeout = setTimeout(() => request.abort(), 10000);
    const uncertain = () => { pendingRef.current = true; setPending(true); setObserved(null); setNote(""); setMessage("لم تتأكد نتيجة رفض المسودة. لن نعيد الطلب تلقائيًا."); };
    try {
      const response = await fetch(`/api/ceph/${id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: observed.discardVersion, note: note.trim() || null }), signal: request.signal });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) {
        if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|ceph_discard_|invalid_ceph_discard$)/.test(String(result.code)))) {
          erase(); setObserved(null); setNote(""); setMessage(typeof result.message === "string" ? result.message : "لم تُرفض المسودة. حدّث الدراسة.");
          if (response.status === 401 || response.status === 403) refresh();
        } else uncertain();
        return;
      }
      if (!result || Object.keys(result).sort().join(",") !== "ok,status,studyId" || result.ok !== true || result.studyId !== id || result.status !== "discarded") { uncertain(); return; }
      erase(); setObserved(null); setNote(""); onDiscarded();
    } catch { if (active.current) uncertain(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  return <div data-testid="canonical-ceph-discard" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    {warning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في هذا التبويب. الاستعادة بعد إعادة التحميل غير مضمونة؛ تحقق قبل المغادرة.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {pending ? <div className="space-y-2 rounded-lg bg-amber-50 p-3">
      <p>طلب رفض سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.</p>
      <button type="button" className={button} disabled={busy} onClick={() => { void inspect(true); }}>التحقق من حالة المسودة</button>
      {checked ? <button type="button" className={button} disabled={busy} onClick={() => { if (sending.current || !active.current) return; erase(); pendingRef.current = false; setPending(false); setPendingId(null); setChecked(false); setMessage(null); }}>راجعت الحالة، إغلاق المتابعة</button> : null}
    </div> : observed && observed.analysis.id === draftId ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void discard(); }}>
      <p>سيُسجّل رفض المسودة باسمك وتبقى بياناتها محفوظة. الدراسة المعتمدة لا تتغيّر. راجع تفاصيل الدراسة قبل التأكيد.</p>
      <p className="text-xs text-slate-600">تاريخ المسودة: <span dir="ltr">{formatClinicDate(observed.analysis.createdAt, observed.clinicTimeZone)}</span> — سجّلها: {observed.analysis.createdBy}</p>
      <label htmlFor={noteId} className="block text-xs font-bold">ملاحظة الرفض (اختيارية)</label>
      <textarea id={noteId} maxLength={4000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} className="block min-h-24 w-full rounded-lg border border-slate-300 p-2" />
      <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy}>{busy ? "جارٍ تسجيل الرفض…" : "تأكيد رفض المسودة"}</button><button type="button" className={button} disabled={busy} onClick={() => { setObserved(null); setNote(""); }}>إلغاء</button></div>
    </form> : draftId ? <button type="button" className={button} disabled={busy} onClick={() => { void inspect(false); }}>مراجعة رفض المسودة الحالية</button> : <p className="text-xs text-slate-600">لا توجد مسودة حالية للرفض.</p>}
  </div>;
}
