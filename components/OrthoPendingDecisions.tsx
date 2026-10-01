"use client";

import { useCallback, useEffect, useState } from "react";
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
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canNoCharge = session?.role === "admin" || session?.role === "doctor";
  const canBill = session?.role === "admin" || session?.role === "reception";

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ortho/billing-decisions", { cache: "no-store" });
      if (!response.ok) return;
      setPending(((await response.json()) as { pending: Pending[] }).pending);
    } catch {
      // البطاقة مساعدة — صفحة التقويم تعمل بدونها.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => { if (!cancelled) await load(); })();
    return () => { cancelled = true; };
  }, [load]);

  async function decide(adjustmentId: number, decision: "no_charge" | "billed") {
    const value = decision === "no_charge"
      ? window.prompt("سبب «بلا رسوم» لهذه الشدّة:")
      : window.prompt("رقم الفاتورة التي فوترت الشدّة:");
    if (!value?.trim()) return;
    const response = await fetch(`/api/ortho/adjustments/${adjustmentId}/billing-decision`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decision === "no_charge" ? { decision, reason: value } : { decision, invoiceNumber: value }),
    });
    const payload = await response.json().catch(() => ({})) as { message?: string };
    setMessage(response.ok ? "حُفظ القرار." : payload.message ?? "تعذّر حفظ القرار.");
    if (response.ok) await load();
  }

  if (!pending || pending.length === 0) return null;
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
              <button type="button" onClick={() => void decide(row.adjustmentId, "billed")}
                className="rounded-lg border border-amber-300 bg-white px-2 py-0.5 font-bold text-amber-900">فوتِرت (رقم الفاتورة)</button>
            ) : null}
            {canNoCharge ? (
              <button type="button" onClick={() => void decide(row.adjustmentId, "no_charge")}
                className="rounded-lg border border-slate-300 bg-white px-2 py-0.5 font-bold text-slate-700">بلا رسوم</button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
