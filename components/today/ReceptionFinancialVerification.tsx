"use client";

import { useEffect, useRef, useState } from "react";
import { readVisitReceivable, type VisitReceivable } from "@/lib/operational-checkout";
import type { ReceptionHandoff } from "@/lib/reception-handoff";

/** Review is independent from the historical handled/deferred decision and never pays a debt. */
export function ReceptionFinancialVerification({ row, username, role, onChanged }: {
  row: ReceptionHandoff; username: string; role: string; onChanged: () => void;
}) {
  const [proof, setProof] = useState<{ receivable: VisitReceivable | null } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "saving" | "saved">("loading");
  const [reason, setReason] = useState("");
  const [refresh, setRefresh] = useState(0);
  const active = useRef(false), epoch = useRef(0);
  useEffect(() => {
    active.current = true; const current = ++epoch.current;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12_000);
    setProof(null); setState("loading");
    void (async () => {
      try {
        const response = await fetch(`/api/visits/${row.visitId}/reception-verification`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const value = await response.json(), receivable = readVisitReceivable(value?.receivable);
        if (value?.version !== 1 || value?.owner?.username !== username || value?.owner?.role !== role
          || value?.visitId !== row.visitId || value?.patientId !== row.patientId || value?.signedAt !== row.signedAt
          || receivable === undefined) throw new Error("Unverified");
        if (active.current && current === epoch.current) { setProof({ receivable }); setState("ready"); }
      } catch { if (active.current && current === epoch.current) { setProof(null); setState("error"); } }
      finally { clearTimeout(timeout); }
    })();
    return () => { active.current = false; epoch.current++; controller.abort(); clearTimeout(timeout); };
  }, [row.visitId, row.patientId, row.signedAt, username, role, refresh]);
  async function verify() {
    if (state !== "ready" || !proof || reason.trim().length < 3) return;
    setState("saving"); const current = ++epoch.current;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/api/visits/${row.visitId}/reception-verification`, { method: "POST",
        headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ patientId: row.patientId, signedAt: row.signedAt, receivable: proof.receivable, reason: reason.trim() }) });
      const result = await response.json();
      if (!response.ok || result?.ok !== true || result?.visitId !== row.visitId || result?.patientId !== row.patientId || result?.signedAt !== row.signedAt) throw new Error("Unverified save");
      if (active.current && current === epoch.current) { setState("saved"); onChanged(); }
    } catch { if (active.current && current === epoch.current) { setProof(null); setState("error"); } }
    finally { clearTimeout(timeout); }
  }
  return <section aria-label={`إعادة التحقق المالي للزيارة ${row.visitId}`} data-verification-state={state} className="w-full rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs">
    <p>القرار السابق باقٍ في السجل. إعادة التحقق تسجّل مراجعة الوضع الحالي ولا تثبت سداد حساب المريض.</p>
    {state === "loading" && <p role="status">جارٍ قراءة مرجع فاتورة الزيارة وحالته الحالية…</p>}
    {state === "error" && <p role="alert">تعذّر التحقق أو تغيّرت الفاتورة. أعد القراءة قبل تسجيل المراجعة.</p>}
    {state === "saved" && <p role="status">سُجّلت إعادة التحقق؛ جارٍ تحديث القائمة.</p>}
    <button type="button" disabled={state === "saving"} onClick={() => setRefresh(value => value + 1)} className="min-h-11 rounded-xl border px-3">قراءة الحالة الحالية من جديد</button>
    {state === "ready" && proof && <>
      <a href={`/patients/${row.patientId}?tab=account`} className="inline-flex min-h-11 items-center rounded-xl border px-3">عرض الحساب الحالي واختيار هدف التحصيل</a>
      <p>{proof.receivable === null ? "لا توجد فاتورة مرتبطة بهذه الزيارة؛ رصيد الحساب مستقل." : `المراجعة لمرجع فاتورة الزيارة #${proof.receivable.invoiceId} (${proof.receivable.currency}).`}</p>
      <label className="block">سبب إعادة التحقق<input value={reason} maxLength={300} onChange={event => setReason(event.target.value)} className="block min-h-11 w-full rounded-xl border px-2" /></label>
      <button type="button" disabled={reason.trim().length < 3} onClick={() => { void verify(); }} className="min-h-11 rounded-xl border px-3">تسجيل إعادة التحقق — لا يثبت السداد</button>
    </>}
  </section>;
}
