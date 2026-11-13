"use client";
import { useEffect, useRef, useState } from "react";
import { cephCompletionFingerprintFromStudy, type CanonicalCephStudy } from "@/lib/canonical-ceph-projection";
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
/** Explicit clinical completion from the saved observation, with ambiguous-response recovery and no automatic retry. */
export function CanonicalCephComplete({ patientId, studyId, ownerKey, feed, refresh, onCompleted }: { patientId: string; studyId: number; ownerKey: string; feed: CanonicalCephStudy | null; refresh: () => void; onCompleted: () => void }) {
  const storageKey = `aqlan.ceph-complete.pending:${encodeURIComponent(ownerKey)}:${patientId}:${studyId}`;
  const [initial] = useState(() => { try { return { pending: sessionStorage.getItem(storageKey) !== null, warning: false }; } catch { return { pending: false, warning: true }; } });
  const [pending, setPending] = useState(initial.pending), [warning, setWarning] = useState(initial.warning), [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<string | null>(null), [reviewed, setReviewed] = useState<{ expectedFingerprint: string } | null>(null), [message, setMessage] = useState<string | null>(null), [unverified, setUnverified] = useState<CanonicalCephStudy | null>(null);
  const active = useRef(false), sending = useRef(false), pendingRef = useRef(initial.pending), controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, [storageKey]);
  useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (sending.current || pendingRef.current) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave); }, []);
  const erase = () => { try { sessionStorage.removeItem(storageKey); } catch { setWarning(true); } };
  const editable = feed?.analysis.status === "draft" && typeof feed.discardVersion === "string";
  const sourcesUnavailable = feed?.analysis.status === "draft" && feed.completionSources?.state !== "available";
  const current = editable && intent !== null && feed.discardVersion === intent;
  const clear = () => { setIntent(null); setReviewed(null); };
  function begin() {
    if (!editable || !feed || sending.current || pendingRef.current) return;
    // The reviewed snapshot and sources are frozen now (as their fingerprint); the server refuses if either changed since.
    const fingerprint = cephCompletionFingerprintFromStudy(feed), request = fingerprint ? { expectedFingerprint: fingerprint } : null;
    if (!request) { setMessage("تعذّر إثبات مصادر الدراسة (الصورة والمرجع)؛ لا يمكن طلب الاعتماد الآن. حدّث الدراسة وراجعها."); return; }
    setIntent(feed.discardVersion!); setReviewed(request); setMessage(null);
  }
  async function save() {
    if (!active.current || sending.current || pendingRef.current || !current || !feed || !reviewed) return;
    const request = new AbortController(); controller.current = request; sending.current = true; setBusy(true); setMessage(null); setUnverified(feed);
    try { sessionStorage.setItem(storageKey, "pending"); } catch { setWarning(true); }
    const timeout = setTimeout(() => request.abort(), 10000);
    const unknown = () => { pendingRef.current = true; setPending(true); clear(); setMessage("لم تتأكد نتيجة اعتماد الدراسة. لن نعيد الطلب تلقائيًا."); refresh(); };
    try {
      const response = await fetch(`/api/ceph/${studyId}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal, body: JSON.stringify(reviewed) });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) { if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|ceph_complete_|invalid_ceph_complete$)/.test(String(result.code)))) { erase(); clear(); setMessage(typeof result.message === "string" ? result.message : "لم تُعتمد الدراسة. راجع حالتها الحالية."); refresh(); } else unknown(); return; }
      if (!result || result.ok !== true || !Array.isArray(result.measurements)) { unknown(); return; }
      erase(); clear(); setMessage("اعتُمدت الدراسة وسُجّلت القياسات وأثر الاعتماد. راجع السجل المحفوظ."); onCompleted();
    } catch { if (active.current) unknown(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  if (!editable && !pending && !message && !intent && !busy) return null;
  return <div data-testid="canonical-ceph-complete" className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
    {warning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في التبويب؛ الاستعادة بعد إعادة التحميل غير مضمونة. تحقق قبل إغلاق الصفحة.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {pending ? <div className="space-y-2 rounded-lg bg-amber-50 p-3"><p>اعتماد سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.</p><button type="button" className={button} disabled={busy} onClick={() => { setUnverified(feed); refresh(); }}>التحقق من الدراسة الحالية</button>
      {feed && feed !== unverified ? <><p className="text-xs">راجع الحالة والقياسات الحالية؛ القراءة ليست إيصالًا لطلب بعينه.</p><button type="button" className={button} onClick={() => { if (sending.current || !feed) return; erase(); pendingRef.current = false; setPending(false); clear(); setMessage(null); }}>راجعت الدراسة، إنهاء المتابعة</button></> : null}</div>
      : !intent ? editable ? <>{sourcesUnavailable ? <p className="text-xs text-amber-800">مصادر الدراسة (الصورة أو المرجع) غير متاحة للتحقق؛ الاعتماد غير ممكن حتى تتوفر.</p> : null}
        <button type="button" className={button} disabled={busy || sourcesUnavailable} onClick={begin}>مراجعة اعتماد الدراسة</button></> : null
        : !feed ? <p role="status">جارٍ التحقق من الدراسة قبل متابعة الاعتماد…</p> : !current ? <div><p>تغيّرت الدراسة. راجع بياناتها الحالية قبل طلب اعتماد جديد.</p><button type="button" className={button} onClick={clear}>إغلاق التأكيد السابق</button></div>
          : <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
            <p className="text-amber-800">سيحسب الاعتماد القياسات من المعايرة والمعالم المحفوظة، ثم يقفل هذه الدراسة باسمك. راجع السجل الحالي قبل التأكيد؛ تصحيح المعتمد يحتاج مسودة جديدة.</p>
            <p className="text-xs">التعديلات غير المحفوظة في نموذج التشخيص لا تدخل هذا الاعتماد. احفظها أولًا ثم راجع الدراسة من جديد.</p>
            <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy}>{busy ? "جارٍ الاعتماد…" : "تأكيد اعتماد الدراسة"}</button><button type="button" className={button} disabled={busy} onClick={clear}>إلغاء التأكيد</button></div>
          </form>}
  </div>;
}
