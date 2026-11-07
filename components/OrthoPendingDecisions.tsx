"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";

interface Pending {
  adjustmentId: number; patientId: number; patientName: string; visitId: number | null;
  doneOn: string; doctorName: string | null; legacy: boolean;
}

/**
 * (P1-C) شدّات خارج العقد بلا قرار فوترة — لا تُترك معلّقة بصمت.
 * «بلا رسوم» بسببٍ للطبيب أو المدير، و«فوتِرت» برقم فاتورة المريض للمدير والاستقبال.
 */
export function OrthoPendingDecisions() {
  const session = useSession();
  if (!session || !["admin", "doctor", "reception"].includes(session.role)) return null;
  // A new authority gets a fresh workspace, including on A → B → A.
  // This is containment only; the API remains the authorization authority.
  const scope = JSON.stringify([session.userId ?? null, session.username, session.role, session.permissions ?? null]);
  return <ScopedPendingDecisions key={scope} role={session.role} />;
}

function ScopedPendingDecisions({ role }: { role: string }) {
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const denied = useRef(false);
  const writing = useRef(false);
  const rows = useRef<Pending[] | null>(null);
  const generation = useRef(0);
  const canNoCharge = role === "admin" || role === "doctor";
  const canBill = role === "admin" || role === "reception";

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; rows.current = null; generation.current += 1; };
  }, []);

  const conceal = useCallback(() => {
    denied.current = true;
    generation.current += 1;
    rows.current = null;
    setPending(null);
    setMessage("انتهت الجلسة أو تغيّرت الصلاحيات. أعد فتح الصفحة.");
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!mounted.current || denied.current) return;
    const request = ++generation.current;
    rows.current = null;
    setPending(null);
    const current = () => mounted.current && !denied.current && request === generation.current && !signal?.aborted;
    try {
      const response = await fetch("/api/ortho/billing-decisions", { cache: "no-store", signal });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) { conceal(); return; }
      if (!response.ok) return;
      const payload = await response.json() as { pending: Pending[] };
      if (!current()) return;
      rows.current = payload.pending;
      setPending(payload.pending);
    } catch {
      // البطاقة مساعدة — صفحة التقويم تعمل بدونها.
    }
  }, [conceal]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => { controller.abort(); };
  }, [load]);

  async function decide(adjustmentId: number, decision: "no_charge" | "billed") {
    const snapshot = pending;
    const current = () => mounted.current && !denied.current && rows.current === snapshot
      && !!snapshot?.some((row) => row.adjustmentId === adjustmentId)
      && (decision === "no_charge" ? canNoCharge : canBill);
    if (!current() || writing.current) return;
    writing.current = true;
    setBusy(true);
    try {
      const value = decision === "no_charge"
        ? window.prompt("سبب «بلا رسوم» لهذه الشدّة:")
        : window.prompt("رقم الفاتورة التي فوترت الشدّة:");
      // A retained handler or a prompt interrupted by an authority change must
      // never send a mutation with the new session's cookie.
      if (!value?.trim() || !current()) return;
      const response = await fetch(`/api/ortho/adjustments/${adjustmentId}/billing-decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision === "no_charge" ? { decision, reason: value } : { decision, invoiceNumber: value }),
      });
      if (!current()) return;
      // Conceal before parsing any (possibly deferred or invalid) denial body.
      if (response.status === 401 || response.status === 403) { conceal(); return; }
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!current()) return;
      setMessage(response.ok ? "حُفظ القرار." : payload.message ?? "تعذّر حفظ القرار.");
      if (response.ok) await load();
    } catch {
      if (current()) setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (!pending || pending.length === 0) return message ? <p role="status">{message}</p> : null;
  return (
    <section aria-label="شدّات بانتظار قرار فوترة" className="mb-4 rounded-2xl border border-rose-200 bg-rose-50/60 p-3 text-xs">
      <h2 className="mb-1 text-sm font-extrabold text-rose-900">شدّات خارج العقد بانتظار قرار فوترة ({pending.length})</h2>
      <p className="mb-2 text-[11px] text-rose-800">لا اتفاق يغطيها ولم تُفوتر ولم تُعفَ — قرّر: فاتورة، أو بلا رسوم بسبب، أو اربط الحالة باتفاق للشدّات القادمة.</p>
      {message ? <p role="status" className="mb-1 font-bold text-navy-900">{message}</p> : null}
      <ul className="space-y-1.5">
        {pending.map((row) => (
          <li key={row.adjustmentId} className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-100 bg-white px-2 py-1.5">
            <a href={`/patients/${row.patientId}?tab=ortho`} className="font-extrabold text-navy-900 underline underline-offset-4">{row.patientName}</a>
            <span className="text-slate-600">{row.doneOn}{row.doctorName ? ` — ${row.doctorName}` : ""}{row.legacy ? " · حالة سابقة" : ""}</span>
            {canBill ? (
              <button type="button" disabled={busy} onClick={() => void decide(row.adjustmentId, "billed")}
                className="rounded-lg border border-amber-300 bg-white px-2 py-0.5 font-bold text-amber-900">فوتِرت (رقم الفاتورة)</button>
            ) : null}
            {canNoCharge ? (
              <button type="button" disabled={busy} onClick={() => void decide(row.adjustmentId, "no_charge")}
                className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 font-bold text-slate-700">بلا رسوم</button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
