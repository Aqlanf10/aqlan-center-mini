"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CanonicalCephStudy } from "@/lib/canonical-ceph-projection";
const labels = { skeletal: "التشخيص الهيكلي", dental: "التشخيص السني", softTissue: "الأنسجة الرخوة", note: "ملاحظة التشخيص", finalDx: "الاستنتاج السيفالومتري" } as const;
type Fields = Record<keyof typeof labels, string>;
const empty: Fields = { skeletal: "", dental: "", softTissue: "", note: "", finalDx: "" };
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
/** Explicit saved draft diagnosis only; image tracing and clinical completion remain separate. */
export function CanonicalCephDraftDiagnosis({ patientId, studyId, ownerKey, feed, refresh }: { patientId: string; studyId: number; ownerKey: string; feed: CanonicalCephStudy | null; refresh: () => void }) {
  const storageKey = `aqlan.ceph-edit.pending:${encodeURIComponent(ownerKey)}:${patientId}:${studyId}`, id = useId();
  const [initial] = useState(() => { try { return { pending: sessionStorage.getItem(storageKey) !== null, warning: false }; } catch { return { pending: false, warning: true }; } });
  const [pending, setPending] = useState(initial.pending), [warning, setWarning] = useState(initial.warning), [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<string | null>(null), [fields, setFields] = useState<Fields>(empty), [message, setMessage] = useState<string | null>(null), [unverified, setUnverified] = useState<CanonicalCephStudy | null>(null);
  const active = useRef(false), sending = useRef(false), pendingRef = useRef(initial.pending), controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, [storageKey]);
  useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (sending.current || pendingRef.current) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave); }, []);
  const erase = () => { try { sessionStorage.removeItem(storageKey); } catch { setWarning(true); } };
  const editable = feed?.analysis.status === "draft" && typeof feed.discardVersion === "string";
  const current = editable && intent !== null && feed.discardVersion === intent;
  const clear = () => { setIntent(null); setFields(empty); };
  function begin() {
    if (!editable || !feed || sending.current || pendingRef.current) return;
    setIntent(feed.discardVersion!); setFields({ skeletal: feed.diagnosis?.skeletal ?? "", dental: feed.diagnosis?.dental ?? "", softTissue: feed.diagnosis?.softTissue ?? "", note: feed.diagnosis?.note ?? "", finalDx: feed.diagnosis?.finalDx ?? "" }); setMessage(null);
  }
  async function save() {
    if (!active.current || sending.current || pendingRef.current || !current || !feed) return;
    if (!fields.finalDx.trim() || Object.values(fields).some(v => v.trim().length > 2000)) { setMessage("اكتب الاستنتاج وراجع طول الحقول؛ لا نختصر التشخيص تلقائيًا."); return; }
    const version = intent, diagnosis = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim() || null]));
    const request = new AbortController(); controller.current = request; sending.current = true; setBusy(true); setMessage(null); setUnverified(feed);
    try { sessionStorage.setItem(storageKey, "pending"); } catch { setWarning(true); }
    const timeout = setTimeout(() => request.abort(), 10000);
    const unknown = () => { pendingRef.current = true; setPending(true); clear(); setMessage("لم تتأكد نتيجة حفظ المسودة. لن نعيد الطلب تلقائيًا."); refresh(); };
    try {
      const response = await fetch(`/api/ceph/${studyId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, signal: request.signal, body: JSON.stringify({ expectedVersion: version, diagnosis }) });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) { if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|ceph_edit_|invalid_ceph_edit$)/.test(String(result.code)))) { erase(); clear(); setMessage(typeof result.message === "string" ? result.message : "لم يُحفظ التعديل. راجع الدراسة الحالية."); refresh(); } else unknown(); return; }
      if (!result || Object.keys(result).sort().join(",") !== "ok,status,studyId" || result.ok !== true || result.studyId !== studyId || result.status !== "draft") { unknown(); return; }
      erase(); clear(); setMessage("حُفظ التشخيص في المسودة وسُجّل أثره. لم تُعتمد الدراسة أو تُغيّر القياسات."); refresh();
    } catch { if (active.current) unknown(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  if (!editable && !pending && !message && !intent && !busy) return null;
  return <div data-testid="canonical-ceph-draft-diagnosis" className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
    {warning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في التبويب؛ الاستعادة بعد إعادة التحميل غير مضمونة. تحقق قبل إغلاق الصفحة.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {pending ? <div className="space-y-2 rounded-lg bg-amber-50 p-3"><p>حفظ سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.</p><button type="button" className={button} disabled={busy} onClick={() => { setUnverified(feed); refresh(); }}>التحقق من الدراسة الحالية</button>
      {feed && feed !== unverified ? <><p className="text-xs">راجع التشخيص والحالة الحالية؛ القراءة ليست إيصالًا لطلب بعينه.</p><button type="button" className={button} onClick={() => { if (sending.current || !feed) return; erase(); pendingRef.current = false; setPending(false); clear(); setMessage(null); }}>راجعت الدراسة، إنهاء المتابعة</button></> : null}</div>
      : !intent ? editable ? <button type="button" className={button} disabled={busy} onClick={begin}>تعديل تشخيص المسودة</button> : null
        : !feed ? <p role="status">جارٍ التحقق من الدراسة قبل متابعة التعديل…</p> : !current ? <div><p>تغيّرت الدراسة. راجع بياناتها الحالية قبل فتح تعديل جديد.</p><button type="button" className={button} onClick={clear}>إغلاق التعديل السابق</button></div>
          : <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}><p className="text-xs text-amber-800">تشخيص مسودة غير معتمد. حفظه لا يغيّر المعايرة أو المعالم أو القياسات المحفوظة.</p>
            {(Object.keys(labels) as (keyof Fields)[]).map(key => <div key={key}><label htmlFor={`${id}-${key}`} className="block text-xs font-bold">{labels[key]}{key === "finalDx" ? " (مطلوب)" : ""}</label><textarea id={`${id}-${key}`} className="mt-1 min-h-20 w-full rounded-lg border border-slate-300 p-2" value={fields[key]} disabled={busy} onChange={e => setFields(value => ({ ...value, [key]: e.target.value }))} /></div>)}
            <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ تشخيص المسودة"}</button><button type="button" className={button} disabled={busy} onClick={clear}>إلغاء التعديل</button></div>
          </form>}
  </div>;
}
