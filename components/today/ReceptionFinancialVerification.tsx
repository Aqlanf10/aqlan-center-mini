"use client";

import { useEffect, useRef, useState } from "react";
import { readSignedReceptionProof, type SignedReceptionProof } from "@/lib/operational-checkout";
import type { ReceptionHandoff } from "@/lib/reception-handoff";
import { X } from "lucide-react";
import styles from "./reception.module.css";

/** Review is independent from the historical handled/deferred decision and never pays a debt. */
export function ReceptionFinancialVerification({ row, username, role, onChanged, onClose, onSaved }: {
  row: ReceptionHandoff; username: string; role: string; onChanged: () => void; onClose: () => void; onSaved: () => void;
}) {
  const [proof, setProof] = useState<SignedReceptionProof | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "saving" | "saved">("loading");
  const [reason, setReason] = useState("");
  const [refresh, setRefresh] = useState(0);
  const active = useRef(false), epoch = useRef(0);
  const writing = useRef(false);
  useEffect(() => {
    active.current = true; const current = ++epoch.current;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12_000);
    setProof(null); setState("loading");
    void (async () => {
      try {
        const response = await fetch(`/api/visits/${row.visitId}/reception-verification`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Unavailable");
        const value = await response.json(), proof = readSignedReceptionProof(value);
        if (value?.version !== 1 || value?.owner?.username !== username || value?.owner?.role !== role
          || value?.visitId !== row.visitId || value?.patientId !== row.patientId || value?.signedAt !== row.signedAt
          || !proof || value.signatureVersion !== row.signatureVersion) throw new Error("Unverified");
        if (active.current && current === epoch.current) { setProof(proof); setState("ready"); }
      } catch { if (active.current && current === epoch.current) { setProof(null); setState("error"); } }
      finally { clearTimeout(timeout); }
    })();
    return () => { active.current = false; epoch.current++; controller.abort(); clearTimeout(timeout); };
  }, [row.visitId, row.patientId, row.signedAt, row.signatureVersion, username, role, refresh]);
  async function verify() {
    if (writing.current || state !== "ready" || !proof || reason.trim().length < 3 || reason.trim().length > 300) return;
    writing.current = true;
    setState("saving"); const current = ++epoch.current;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/api/visits/${row.visitId}/reception-verification`, { method: "POST",
        headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ ...proof, reason: reason.trim() }) });
      const result = await response.json();
      if (!response.ok || result?.ok !== true || result?.visitId !== row.visitId || result?.patientId !== row.patientId || result?.signedAt !== row.signedAt) throw new Error("Unverified save");
      if (active.current && current === epoch.current) { setState("saved"); onSaved(); }
    } catch { if (active.current && current === epoch.current) { setProof(null); setState("error"); } }
    finally { writing.current = false; clearTimeout(timeout); }
  }
  return <section aria-label={`إعادة التحقق المالي للزيارة ${row.visitId}`} data-verification-state={state} className={styles.detail}>
    <header className={styles.detailHeading}><div><h3>{row.patientName} · زيارة #{row.visitId}</h3><p>إعادة التحقق المالي</p></div>
      <button type="button" onClick={onClose} className={styles.close} aria-label="إغلاق تفاصيل المراجعة"><X size={18} aria-hidden="true" /></button></header>
    <p className={styles.debtNote}>القرار السابق باقٍ في السجل. إعادة التحقق تسجّل مراجعة الوضع الحالي ولا تثبت سداد حساب المريض.</p>
    {state === "loading" && <p role="status">جارٍ قراءة مرجع فاتورة الزيارة وحالته الحالية…</p>}
    {state === "error" && <p role="alert">تعذّر التحقق أو تغيّرت الفاتورة. أعد القراءة قبل تسجيل المراجعة.</p>}
    {state === "saved" && <p role="status">سُجّلت إعادة التحقق؛ جارٍ تحديث القائمة.</p>}
    <button type="button" disabled={state === "saving"} onClick={() => { setRefresh(value => value + 1); onChanged(); }} className={styles.subtle}>قراءة الحالة الحالية من جديد</button>
    {state === "ready" && proof && <>
      <a href={`/patients/${row.patientId}?tab=account`} className={styles.primary}>عرض الحساب الحالي واختيار هدف التحصيل</a>
      <p className={styles.invoice}>{proof.receivable === null ? "لا توجد فاتورة مرتبطة بهذه الزيارة؛ رصيد الحساب مستقل." : `المراجعة لمرجع فاتورة الزيارة #${proof.receivable.invoiceId} (${proof.receivable.currency}).`}</p>
      <label className={styles.reason}>سبب إعادة التحقق<input value={reason} maxLength={300} onChange={event => setReason(event.target.value)} placeholder="اكتب سبب القرار (٣–٣٠٠ حرف)" /></label>
      <button type="button" disabled={reason.trim().length < 3} onClick={() => { void verify(); }} className={styles.primary}>تسجيل إعادة التحقق — لا يثبت السداد</button>
    </>}
  </section>;
}
