"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  MISSED_APPOINTMENT_LABEL, REFERRAL_SPECIALTY_LABEL, REFERRAL_URGENCY_LABEL, WORKFLOW_STATE_LABEL,
  type Referral,
} from "@/lib/referrals";

/**
 * (REF-2) «عملي السريري» — docs/INTERNAL_REFERRAL_WORKFLOW.md §8.
 *
 * قائمةٌ واحدة للطبيب من بياناتٍ قائمة: ما أُحيل إليّ، ومرضاي اليوم مع سياق الإحالة، وما أحلتُه
 * ولم يعد، وما عاد إليّ ولم أطّلع عليه. كل سطرٍ يفتح ملف المريض — والخطوات نفسها هناك.
 */

type Row = Referral & { patientName: string };
interface TodayRow {
  appointmentId: number; patientId: number; patientName: string; time: string; status: string;
  referralId: number | null; referralReason: string | null; referredBy: string | null;
}
interface Feed { toMe: Row[]; sentOpen: Row[]; returnedToMe: Row[]; today: TodayRow[] }

const APPOINTMENT_STATUS: Record<string, string> = {
  booked: "محجوز", arrived: "وصل", done: "تمّ", no_show: "لم يحضر", cancelled: "أُلغي",
};

function ageDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function ReferralLine({ row, side }: { row: Row; side: "to" | "from" }) {
  const state = row.workflowState ? WORKFLOW_STATE_LABEL[row.workflowState] : "";
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a href={`/patients/${row.patientId}?tab=treatment`} className="text-sm font-extrabold text-navy-900 hover:underline">
          {row.patientName}
        </a>
        <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-bold text-slate-700">{state}</span>
      </div>
      <p className="mt-1 text-xs text-slate-700">
        {REFERRAL_SPECIALTY_LABEL[row.toSpecialty]}
        {row.teeth ? <> · الأسنان <span dir="ltr">{row.teeth}</span></> : null}
        {row.urgency !== "routine" ? ` · ${REFERRAL_URGENCY_LABEL[row.urgency]}` : ""}
        {side === "to" ? (row.doctorName ? ` · من ${row.doctorName}` : "") : ` · إلى ${row.toName}`}
        {` · منذ ${ageDays(row.createdAt)} يوم`}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{row.reason}</p>
      {row.appointmentDate ? <p className="mt-1 text-[11px] font-bold text-slate-600">📅 {row.appointmentDate}</p> : null}
      {row.missedAppointment ? (
        <p className="mt-1 text-[11px] font-bold text-amber-700">⚠️ {MISSED_APPOINTMENT_LABEL[row.missedAppointment]} — بانتظار إعادة الحجز</p>
      ) : null}
      {row.procedurePerformed ? <p className="mt-1 text-xs font-bold text-emerald-800">ما أُنجز: {row.procedurePerformed}</p> : null}
      {row.outcomeNote ? <p className="mt-1 text-xs text-slate-600">ملاحظة: {row.outcomeNote}</p> : null}
    </li>
  );
}

function Section({ title, empty, children, count }: { title: string; empty: string; children: React.ReactNode; count: number }) {
  return (
    <section className="mb-5" aria-label={title}>
      <h2 className="mb-2 text-sm font-extrabold text-navy-900">{title} <span className="text-slate-400">({count})</span></h2>
      {count === 0 ? <p className="text-xs text-slate-500">{empty}</p> : <ul className="space-y-2">{children}</ul>}
    </section>
  );
}

export default function MyWorkPage() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/referrals/mine", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as (Feed & { message?: string }) | null;
      if (!response.ok || !payload) { setError(payload?.message ?? "تعذّر تحميل عملك السريري."); return; }
      setFeed({ toMe: payload.toMe ?? [], sentOpen: payload.sentOpen ?? [], returnedToMe: payload.returnedToMe ?? [], today: payload.today ?? [] });
      setError(null);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main dir="rtl" className="mx-auto max-w-4xl p-4 pb-24">
      <PageHeader title="عملي السريري" subtitle="الإحالات إليك ومنك، وما عاد إليك، ومرضاك اليوم" />
      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>
      ) : null}
      {!feed && !error ? <p className="text-xs text-slate-400">جارٍ التحميل…</p> : null}
      {feed ? (
        <>
          <Section title="عادت إليك" empty="لا إحالات عادت إليك بانتظار اطّلاعك." count={feed.returnedToMe.length}>
            {feed.returnedToMe.map((row) => <ReferralLine key={row.id} row={row} side="from" />)}
          </Section>
          <Section title="أُحيلت إليك" empty="لا إحالات مفتوحة إليك." count={feed.toMe.length}>
            {feed.toMe.map((row) => <ReferralLine key={row.id} row={row} side="to" />)}
          </Section>
          <Section title="مرضاك اليوم" empty="لا مواعيد لك اليوم." count={feed.today.length}>
            {feed.today.map((row) => (
              <li key={row.appointmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
                <a href={`/patients/${row.patientId}`} className="text-sm font-extrabold text-navy-900 hover:underline">
                  <span dir="ltr" className="ml-2 text-xs text-slate-500">{row.time}</span>{row.patientName}
                </a>
                <span className="text-[11px] font-bold text-slate-600">
                  {APPOINTMENT_STATUS[row.status] ?? row.status}
                  {row.referralId ? ` · 📨 إحالة${row.referredBy ? ` من ${row.referredBy}` : ""}: ${row.referralReason ?? ""}` : ""}
                </span>
              </li>
            ))}
          </Section>
          <Section title="أحلتَها ولم تعد بعد" empty="لا إحالات مفتوحة منك." count={feed.sentOpen.length}>
            {feed.sentOpen.map((row) => <ReferralLine key={row.id} row={row} side="from" />)}
          </Section>
        </>
      ) : null}
    </main>
  );
}
