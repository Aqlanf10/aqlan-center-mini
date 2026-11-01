"use client";
import { useEffect, useState } from "react";
import { isCanonicalOrthoDecisions, type CanonicalOrthoDecisions } from "@/lib/canonical-ortho-decisions-projection";
import { CanonicalOrthoDecisionEditor } from "./CanonicalOrthoDecisionEditor";
import { useSession } from "./SessionProvider";
/** Minimal review queue with independently authorized decision commands. */
export function CanonicalOrthoPendingDecisions() {
  const session = useSession();
  const [feed, setFeed] = useState<CanonicalOrthoDecisions | null>(null), [error, setError] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true, sequence = 0, controller: AbortController | undefined;
    const clear = () => { sequence++; controller?.abort(); setFeed(null); setError(null); };
    const load = async () => {
      clear(); if (document.visibilityState === "hidden") return;
      const request = sequence, current = new AbortController(); controller = current; const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const response = await fetch("/api/ortho/billing-decisions", { cache: "no-store", signal: current.signal }), value: unknown = await response.json().catch(() => null);
        if (!alive || request !== sequence) return;
        if (!response.ok || !isCanonicalOrthoDecisions(value)) throw new Error("invalid decision queue"); setFeed(value);
      } catch { if (alive && request === sequence) setError("تعذّر التحقق من قائمة المراجعة. أعد التحميل؛ لم تُعتبر فارغة."); }
      finally { clearTimeout(timeout); }
    };
    const visible = () => { if (document.visibilityState === "hidden") clear(); else void load(); }, focus = () => { void load(); };
    void load(); const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    return () => { alive = false; sequence++; controller?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  return <section data-testid="canonical-ortho-decisions" aria-label="شدّات تحتاج مراجعة قرارها" className="mb-4 space-y-3 rounded-2xl border border-amber-200 bg-amber-50/40 p-4 text-sm [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-extrabold text-navy-900">شدّات تحتاج مراجعة قرارها</h2><button type="button" onClick={() => { setFeed(null); setError(null); setRefresh(n => n + 1); }} className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-xs font-bold text-navy-800">تحديث قائمة المراجعة</button></div>
    {error ? <p role="alert" className="text-red-800">{error}</p> : !feed ? <p role="status">جارٍ تحميل قائمة المراجعة…</p> : <div data-testid="ortho-decision-summary" className="space-y-3">
      <p className="text-xs text-slate-600">هذه الشدّات تنتظر قرارًا بحسب تصنيفها المسجّل. القائمة وحدها لا تثبت غياب اتفاق أو فاتورة، ولا تمنح صلاحية تغيير القرار.</p>
      {feed.pending.length ? <ul className="space-y-2">{feed.pending.map(row => <li key={row.adjustmentId} className="rounded-xl border border-slate-200 bg-white p-3"><a href={`/patients/${row.patientId}`} className="font-bold text-navy-900 underline underline-offset-4">{row.patientName}</a><p className="mt-1 text-xs text-slate-600"><bdi>{row.doneOn}</bdi>{row.doctorName ? ` — ${row.doctorName}` : ""}{row.legacy ? " · حالة سابقة" : ""}</p></li>)}</ul> : <p>لا شدّات بانتظار المراجعة ضمن نطاقك.</p>}
      {feed.hasMore ? <p role="status" className="font-bold text-amber-900">تظهر أقدم 300 شدّة ضمن نطاقك فقط؛ القائمة غير كاملة.</p> : null}
    </div>}
    {session?.username ? <CanonicalOrthoDecisionEditor key={session.username} ownerKey={session.username} feed={feed} refresh={() => { setFeed(null); setError(null); setRefresh(n => n + 1); }} /> : null}
  </section>;
}
