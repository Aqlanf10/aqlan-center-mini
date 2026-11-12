"use client";
import { useEffect, useRef, useState } from "react";
import { isCanonicalCephList } from "@/lib/canonical-ceph-projection";
import type { CephCorrectionSourceToken } from "@/lib/ceph-correction-origin";

const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
export function CanonicalCephCopy({ patientId, studyId, ownerKey, correctionToken, onCopied, refreshStudy }: {
  patientId: string; studyId: number; ownerKey: string;
  /** Staging's correction-source token of the observed completed study; without it no copy is requested. */
  correctionToken: CephCorrectionSourceToken | null; onCopied: () => void; refreshStudy: () => void;
}) {
  const storageKey = `aqlan.ceph-copy.pending:${encodeURIComponent(ownerKey)}:${patientId}:${studyId}`;
  const [initial] = useState(() => { try { return { pending: sessionStorage.getItem(storageKey) !== null, warning: false }; } catch { return { pending: false, warning: true }; } });
  const [pending, setPending] = useState(initial.pending), [warning, setWarning] = useState(initial.warning);
  const [armed, setArmed] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [checked, setChecked] = useState<"none" | "draft" | null>(null);
  const active = useRef(false), sending = useRef(false), pendingRef = useRef(initial.pending), controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, [storageKey]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (sending.current || pendingRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave);
  }, []);
  const erase = () => { try { sessionStorage.removeItem(storageKey); } catch { setWarning(true); } };
  async function copy() {
    if (!active.current || sending.current || pendingRef.current) return;
    if (!correctionToken) { setMessage("تعذّر إثبات أصل التصحيح لهذه الدراسة؛ لم يُرسل طلب. حدّث الدراسة."); return; }
    sending.current = true; setBusy(true); setMessage(null); setChecked(null);
    const request = new AbortController(); controller.current = request;
    try { sessionStorage.setItem(storageKey, "pending"); } catch { setWarning(true); }
    const timeout = setTimeout(() => request.abort(), 10000);
    const uncertain = () => {
      pendingRef.current = true; setPending(true); setArmed(false);
      setMessage("لم تتأكد نتيجة نسخة التصحيح. لن نعيد الطلب تلقائيًا؛ تحقق من الدراسات الحالية.");
    };
    try {
      const response = await fetch(`/api/ceph/${studyId}/duplicate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, expectedCorrectionSource: correctionToken }), signal: request.signal });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) {
        if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|ceph_copy_|invalid_ceph_copy$)/.test(String(result.code)))) {
          erase(); setArmed(false); setMessage(typeof result.message === "string" ? result.message : "لم تُنشأ نسخة التصحيح. حدّث الدراسة.");
          if (response.status === 401 || response.status === 403) refreshStudy();
        } else uncertain();
        return;
      }
      if (!result || Object.keys(result).join(",") !== "id" || !Number.isSafeInteger(result.id) || result.id <= 0 || result.id === studyId) { uncertain(); return; }
      erase(); setArmed(false); onCopied();
    } catch { if (active.current) uncertain(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  async function checkCurrent() {
    if (!active.current || sending.current) return;
    sending.current = true; setBusy(true); setChecked(null); setMessage(null);
    const request = new AbortController(); controller.current = request;
    const timeout = setTimeout(() => request.abort(), 8000);
    try {
      const response = await fetch(`/api/patients/${patientId}/ceph`, { cache: "no-store", signal: request.signal });
      const body = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok || !isCanonicalCephList(body, Number(patientId))) throw new Error("تعذّر التحقق من الدراسات الحالية. لم يُرسل طلب تصحيح آخر.");
      // The accepted list puts every current draft before completed history.
      setChecked(body.analyses.some(study => study.status === "draft") ? "draft" : "none");
    } catch { if (active.current) setMessage("تعذّر التحقق من الدراسات الحالية. لم يُرسل طلب تصحيح آخر."); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  return <div data-testid="canonical-ceph-copy" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    {warning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في هذا التبويب. تجنب إغلاق الصفحة قبل التأكد؛ الاستعادة بعد إعادة التحميل غير مضمونة.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {pending ? <div className="space-y-2 rounded-lg bg-amber-50 p-3">
      <p>طلب نسخة تصحيح سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.</p>
      <button type="button" className={button} disabled={busy} onClick={() => { void checkCurrent(); }}>التحقق من الدراسات الحالية</button>
      {checked === "draft" ? <p>توجد مسودة حالية. راجعها من قائمة الدراسات؛ لم تُنشأ نسخة أخرى، ووجودها لا يثبت نتيجة طلب بعينه.</p> : null}
      {checked === "none" ? <><p className="text-xs">لا توجد مسودة حالية. قد يكون طلب سابق قد نُفذ ثم تغيّرت حالته؛ راجع السجل قبل نية جديدة.</p>
        <button type="button" className={button} disabled={busy} onClick={() => { if (!active.current || sending.current) return; erase(); pendingRef.current = false; setPending(false); setChecked(null); setArmed(true); setMessage(null); }}>راجعت السجل، بدء طلب تصحيح جديد</button></> : null}
    </div> : armed ? <div className="space-y-2">
      <p>ستُنشأ مسودة على مرجع الصورة نفسه بالمعالم والمعايرة المحفوظة. يبقى التحليل المعتمد كما هو، ولا تُنسخ نتائجه كاعتماد جديد.</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={() => { void copy(); }}>{busy ? "جارٍ فتح المسودة…" : "إنشاء مسودة التصحيح"}</button>
        <button type="button" className={button} disabled={busy} onClick={() => setArmed(false)}>إلغاء</button></div>
    </div> : <button type="button" className={button} disabled={busy} onClick={() => { setArmed(true); setMessage(null); }}>فتح نسخة تصحيح</button>}
  </div>;
}
