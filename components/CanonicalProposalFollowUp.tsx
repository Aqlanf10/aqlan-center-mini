"use client";
import { useEffect, useState } from "react";
import { isCanonicalProposalFeed, type CanonicalProposalFeed } from "@/lib/canonical-proposal-projection";
import { PROPOSAL_STAGE_LABEL } from "@/lib/consultation-followup";
import { formatMoney } from "@/lib/money";

/** Scoped summary only. No legacy editor, automatic dispatch or consent change. */
export function CanonicalProposalFollowUp() {
  const [feed, setFeed] = useState<CanonicalProposalFeed | null>(null), [error, setError] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true, sequence = 0, controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); setFeed(null); setError(null); };
    const load = async () => {
      clear(); if (document.visibilityState === "hidden") return;
      const request = sequence, current = new AbortController(); controller = current;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch("/api/plans/proposals", { cache: "no-store", signal: current.signal }), value: unknown = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok || !isCanonicalProposalFeed(value)) throw new Error("invalid proposal feed"); setFeed(value);
      } catch { if (alive && request === sequence) setError("تعذّر التحقق من عروض العلاج. أعد التحميل؛ لم تُعتبر القائمة فارغة."); }
      finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); }, focus = () => { void load(); };
    void load(); const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  return <section aria-label="عروض علاج بانتظار قرار المريض" data-testid="canonical-proposals" className="mb-6 rounded-2xl border border-navy-100 bg-white p-4 shadow-2xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-extrabold text-navy-900">عروض علاج بانتظار قرار المريض</h2>
      <button type="button" onClick={() => { setFeed(null); setError(null); setRefresh(v => v + 1); }} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">تحديث عروض العلاج</button></div>
    {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : !feed ? <p role="status" className="mt-3 text-sm">جارٍ تحميل العروض…</p> : <div data-testid="proposal-summary" className="mt-3 space-y-3 text-sm">
      <p className="text-xs text-slate-600">عروض سارية بلا موافقة مسجلة. فترة المتابعة {feed.followUpDays} أيام؛ هذه القراءة لا توافق على العرض أو تغيّر الاتفاق.</p>
      {!feed.proposals.length ? <p>لا عروض معلّقة ضمن مرضاك.</p> : <ul className="space-y-3">{feed.proposals.map(row => <li key={row.planId} data-plan-id={row.planId} className="rounded-xl border border-slate-200 p-3 [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center justify-between gap-2"><a href={`/patients/${row.patientId}`} className="font-bold text-navy-900 underline underline-offset-4">{row.patientName}</a><span className="rounded-lg bg-slate-100 px-2 py-1 text-xs">{PROPOSAL_STAGE_LABEL[row.timing.stage]}</span></div>
        <p className="mt-2">{row.title} — {row.items} بند</p>
        {row.money ? <p className="font-bold">{formatMoney(row.money.totalMinor, row.money.currency)}</p> : null}
        <p className="mt-1 text-xs text-slate-600">أُعدّ قبل {row.timing.ageDays} يوم{row.doctorName ? ` — ${row.doctorName}` : ""}</p>
        <p className="text-xs text-slate-600">{row.timing.daysSinceContact === null ? "لا تواصل مسجل لهذا العرض" : `آخر تواصل قبل ${row.timing.daysSinceContact} يوم`}</p>
        {row.patientPhone ? <p className="mt-2 text-xs">هاتف المريض: <span dir="ltr">{row.patientPhone}</span></p> : null}
      </li>)}</ul>}
      {feed.hasMore ? <p role="status" className="text-amber-800">تظهر أقدم 300 عرض ضمن نطاقك فقط؛ هذه ليست القائمة الكاملة. التصنيف والأولوية داخل العروض المعروضة.</p> : null}
    </div>}
  </section>;
}
