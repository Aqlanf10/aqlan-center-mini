"use client";

import { useCallback, useEffect, useState } from "react";
import { PROPOSAL_STAGE_LABEL, type ProposalTiming } from "@/lib/consultation-followup";
import { formatMoney, type Currency } from "@/lib/money";
import { toWhatsAppNumber } from "@/lib/reminders";

interface Proposal {
  planId: number; patientId: number; patientName: string; patientPhone: string | null;
  title: string; doctorName: string | null; createdOn: string; lastContactOn: string | null;
  items: number; totalMinor: number | null; currency: Currency; timing: ProposalTiming;
  whatsappAllowed: boolean;
}

const STAGE_CLASS: Record<ProposalTiming["stage"], string> = {
  due: "border-amber-300 bg-amber-50 text-amber-900",
  stale: "border-red-200 bg-red-50 text-red-800",
  contacted: "border-emerald-200 bg-emerald-50 text-emerald-800",
  fresh: "border-slate-200 bg-slate-50 text-slate-700",
};

/**
 * (P1-E) استشارة المريض الجديد: عروض العلاج التي لم يقرر فيها المريض بعد — للاتصال والمتابعة.
 * الموافقة أو الإلغاء من ملف المريض (تبويب الخطط) بمسارَيهما القائمين؛ هنا يُسجَّل التواصل فقط.
 */
export function ProposalFollowUp() {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [followUpDays, setFollowUpDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/plans/proposals", { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { proposals?: Proposal[]; followUpDays?: number; message?: string };
      if (!response.ok) { setError(payload.message ?? "تعذّر تحميل عروض العلاج."); return; }
      setProposals(payload.proposals ?? []);
      setFollowUpDays(payload.followUpDays ?? 7);
      setError(null);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => { if (!cancelled) await load(); })();
    return () => { cancelled = true; };
  }, [load]);

  async function contacted(planId: number) {
    const note = window.prompt("ملاحظة التواصل (اختياري) — مثل: «سيرد بعد العيد»");
    /* «إلغاء» لا يسجّل تواصلًا لم يحدث؛ ملاحظةٌ فارغة مُرسَلة عمدًا مقبولة. */
    if (note === null) return;
    setBusy(planId);
    try {
      const response = await fetch("/api/plans/proposals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId, note }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) { setError(payload.message ?? "تعذّر تسجيل التواصل."); return; }
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (proposals === null && !error) return null;
  const due = (proposals ?? []).filter((one) => one.timing.stage === "due" || one.timing.stage === "stale").length;

  return (
    <section aria-label="عروض علاج بانتظار قرار المريض" className="mb-6 rounded-2xl border border-navy-100 bg-white p-4 shadow-2xs">
      <h2 className="mb-1 text-sm font-extrabold text-navy-900">
        عروض علاج بانتظار قرار المريض {proposals ? `(${proposals.length}${due ? ` — ${due} للاتصال` : ""})` : ""}
      </h2>
      <p className="mb-3 text-[11px] text-slate-600">
        خطط أُعدّت بعد الكشف ولم يوافق عليها المريض بعد. تظهر للاتصال بعد {followUpDays} يومًا من إعدادها أو من آخر تواصل.
        الموافقة أو الإلغاء من ملف المريض.
      </p>
      {error ? <p role="alert" className="mb-2 text-xs font-bold text-red-700">{error}</p> : null}
      {proposals && proposals.length === 0 ? <p className="text-xs text-slate-500">لا عروض معلّقة.</p> : null}
      <ul className="space-y-2">
        {(proposals ?? []).map((one) => {
          /* (PAT-3) لا رابط واتساب لمن سحب موافقته أو لم يوافق في وضع «بموافقة فقط». */
          const whatsapp = one.patientPhone && one.whatsappAllowed ? toWhatsAppNumber(one.patientPhone) : null;
          return (
            <li key={one.planId} className="rounded-xl border border-slate-200 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <a href={`/patients/${one.patientId}?tab=plans`} className="font-extrabold text-navy-900 underline underline-offset-4">
                  {one.patientName}
                </a>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${STAGE_CLASS[one.timing.stage]}`}>
                  {PROPOSAL_STAGE_LABEL[one.timing.stage]}
                </span>
                <span className="text-slate-600">{one.title} · {one.items} بند</span>
                {one.totalMinor !== null ? <span className="font-bold text-slate-800">{formatMoney(one.totalMinor, one.currency)}</span> : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
                <span>أُعدّ قبل {one.timing.ageDays} يوم{one.doctorName ? ` — ${one.doctorName}` : ""}</span>
                <span>{one.timing.daysSinceContact === null ? "لم يُتواصل بعد" : `آخر تواصل قبل ${one.timing.daysSinceContact} يوم`}</span>
                {one.patientPhone ? <a href={`tel:${one.patientPhone}`} className="font-bold text-navy-800 underline">اتصال</a> : null}
                {whatsapp ? <a href={`https://wa.me/${whatsapp}`} target="_blank" rel="noreferrer" className="font-bold text-emerald-700 underline">واتساب</a> : null}
                <button type="button" disabled={busy === one.planId} onClick={() => void contacted(one.planId)}
                  className="rounded-lg border border-navy-300 bg-white px-2 py-0.5 font-bold text-navy-900 hover:bg-navy-100 disabled:opacity-50">
                  ✓ تواصلت معه
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
