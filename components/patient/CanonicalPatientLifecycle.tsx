"use client";

import { useRef, useState } from "react";

/**
 * Merge a duplicate file into this one, or delete a file registered by mistake (M2 slice 79).
 * Offered by the capability projection (`patients.merge` / `patients.delete` or the owner);
 * the server decides every request: scope, confirmation, financial and clinical guards.
 * Each form needs the exact file number typed again; a request is sent once per press.
 */
export function CanonicalPatientLifecycle({ patientId, patientNumber, canMerge, canDelete, onMerged, onDeleted }: {
  patientId: number; patientNumber: string; canMerge: boolean; canDelete: boolean;
  onMerged: () => void; onDeleted: () => void;
}) {
  const [mergeNumber, setMergeNumber] = useState("");
  const [mergeConfirm, setMergeConfirm] = useState("");
  const [mergeReason, setMergeReason] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "done"; text: string } | null>(null);
  const sending = useRef(false);
  if (!canMerge && !canDelete) return null;

  async function send(url: string, method: "POST" | "DELETE", body: Record<string, unknown>): Promise<{ ok: boolean; data: { message?: string } | null }> {
    if (sending.current) return { ok: false, data: null };
    sending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) setMessage({ kind: "error", text: data?.message ?? "تعذّر إتمام العملية." });
      return { ok: response.ok, data };
    } catch {
      setMessage({ kind: "error", text: "تعذّر الاتصال بالخادم. تحقّق من الملف قبل إعادة المحاولة." });
      return { ok: false, data: null };
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const mergeReady = mergeNumber.trim() !== "" && mergeConfirm.trim().toUpperCase() === mergeNumber.trim().toUpperCase();
  return (
    <details className="rounded-2xl border border-red-200 bg-white p-4" data-testid="canonical-patient-lifecycle">
      <summary className="min-h-11 cursor-pointer text-sm font-bold text-red-800">دمج ملف مكرر أو حذف الملف</summary>
      <div className="mt-3 space-y-4">
        {message ? <p role={message.kind === "error" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-sm ${message.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{message.text}</p> : null}
        {canMerge ? (
          <form className="space-y-2" aria-label="دمج ملف مكرر" onSubmit={async event => {
            event.preventDefault();
            if (!mergeReady) return;
            const result = await send(`/api/patients/${patientId}/merge`, "POST", { duplicatePatientNumber: mergeNumber.trim(), confirmDuplicateNumber: mergeConfirm.trim(), reason: mergeReason.trim() || null });
            if (result.ok) { setMessage({ kind: "done", text: result.data?.message ?? "دُمج الملف." }); setMergeNumber(""); setMergeConfirm(""); setMergeReason(""); onMerged(); }
          }}>
            <h3 className="text-sm font-bold text-navy-900">دمج ملف مكرر في هذا الملف</h3>
            <p className="text-xs text-slate-600">يُنقل كل ما في الملف المكرر إلى هذا الملف ثم يُحذف المكرر. الملف ذو الأثر المالي لا يُدمج.</p>
            <label className="block text-xs font-semibold">رقم الملف المكرر<input className="input mt-1 block w-full" dir="ltr" value={mergeNumber} onChange={event => setMergeNumber(event.target.value)} disabled={busy} /></label>
            <label className="block text-xs font-semibold">أعد كتابة رقم الملف المكرر<input className="input mt-1 block w-full" dir="ltr" value={mergeConfirm} onChange={event => setMergeConfirm(event.target.value)} disabled={busy} autoComplete="off" /></label>
            <label className="block text-xs font-semibold">السبب (اختياري)<input className="input mt-1 block w-full" value={mergeReason} onChange={event => setMergeReason(event.target.value)} maxLength={300} disabled={busy} /></label>
            <button type="submit" className="min-h-11 rounded-xl bg-red-700 px-4 text-sm font-bold text-white disabled:opacity-50" disabled={busy || !mergeReady}>دمج الملفين</button>
          </form>
        ) : null}
        {canDelete ? (
          <form className="space-y-2" aria-label="حذف الملف" onSubmit={async event => {
            event.preventDefault();
            if (deleteConfirm.trim() !== patientNumber) return;
            const result = await send(`/api/patients/${patientId}`, "DELETE", { confirmPatientNumber: deleteConfirm.trim(), reason: deleteReason.trim() || null });
            if (result.ok) onDeleted();
          }}>
            <h3 className="text-sm font-bold text-navy-900">حذف ملف سُجّل خطأً</h3>
            <p className="text-xs text-slate-600">لا يُحذف ملفٌ له أثر مالي أو سجل طبي. اكتب رقم الملف <span dir="ltr" className="font-bold">{patientNumber}</span> للتأكيد.</p>
            <label className="block text-xs font-semibold">رقم الملف للتأكيد<input className="input mt-1 block w-full" dir="ltr" value={deleteConfirm} onChange={event => setDeleteConfirm(event.target.value)} disabled={busy} autoComplete="off" /></label>
            <label className="block text-xs font-semibold">السبب (اختياري)<input className="input mt-1 block w-full" value={deleteReason} onChange={event => setDeleteReason(event.target.value)} maxLength={300} disabled={busy} /></label>
            <button type="submit" className="min-h-11 rounded-xl border border-red-700 px-4 text-sm font-bold text-red-700 disabled:opacity-50" disabled={busy || deleteConfirm.trim() !== patientNumber}>حذف الملف نهائيًا</button>
          </form>
        ) : null}
      </div>
    </details>
  );
}
