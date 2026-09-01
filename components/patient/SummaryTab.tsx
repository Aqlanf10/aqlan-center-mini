"use client";

import { useState } from "react";
import { formatMoney, type Currency } from "@/lib/money";
import { friendlyDate, friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { getAppointmentTypeLabel } from "@/lib/schedule";
import { PLANNED_VISIT_STATUS_LABEL, type PlannedVisitStatus } from "@/lib/workflow";
import { CollectPaymentModal } from "../CollectPaymentModal";
import { PatientTimeline } from "./PatientTimeline";

/**
 * تبويب الملخص — «ما وضع هذا المريض، وما المطلوب مني الآن؟» (المواصفة §٥).
 *
 * يجيب فورًا: الموعد القادم، وآخر زيارة، والخطة النشطة وتقدّمها، والجلسة التالية،
 * والحساب **للمخوّل ماليًا فقط** (الملخص يصله بلا أرصدة من الخادم أصلًا)، والتنبيهات.
 * ومن هنا تُجدول الجلسة المخطَّطة (تاريخٌ ووقت فقط) ويُفتح التحصيل الموحَّد.
 */

export interface WorkflowSummary {
  openVisit: { id: number; status: string; chair: number | null; arrivedAt: string; plannedTitle: string | null } | null;
  lastVisit: { id: number; date: string; treatmentDone: string | null; proceduresSummary: string | null; nextPlan: string | null } | null;
  nextAppointment: {
    id: number; date: string; time: string; durationMinutes: number;
    appointmentType: string | null; note: string | null; status: string;
  } | null;
  activePlans: {
    id: number; title: string; specialty: string | null; primaryDoctorName: string | null;
    consentAt: string | null; itemsCount: number; doneItems: number;
    totalMinor: number; doneMinor: number; remainingMinor: number;
    nextDueDate: string | null; overdueMinor: number;
  }[];
  plannedVisits: {
    id: number; planTitle: string | null; sequence: number; title: string;
    doctorName: string | null; durationMinutes: number; status: PlannedVisitStatus;
    appointmentDate: string | null; appointmentTime: string | null; note: string | null;
  }[];
  counts: { visits: number; openLabOrders: number; documents: number; orthoCase: boolean };
  financial: {
    balanceMinor: number; invoicedMinor: number; paidMinor: number; openingMinor: number;
    agreedMinor: number; treatmentDoneMinor: number; remainingTreatmentMinor: number;
  } | null;
  alerts: { kind: string; severity: "info" | "warning" | "danger"; text: string }[];
  canSeeFinancial: boolean;
}

const SEVERITY_STYLE: Record<string, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-800",
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  danger: "border-red-300 bg-red-50 text-red-700",
};

export function SummaryTab({
  summary,
  patientId,
  patientName,
  base,
  onVisitStarted,
  onChanged,
  onGoToTab,
}: {
  summary: WorkflowSummary;
  patientId: number;
  patientName: string;
  base: Currency;
  onVisitStarted: () => void;
  onChanged: () => void;
  onGoToTab: (tab: string) => void;
}) {
  const [scheduleFor, setScheduleFor] = useState<number | null>(null);
  const [scheduleDate, setScheduleDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  });
  const [scheduleTime, setScheduleTime] = useState("16:00");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const financial = summary.financial;
  const primaryPlan = summary.activePlans[0] ?? null;
  const nextPlanned = summary.plannedVisits.find((visit) => !visit.appointmentDate) ?? null;
  const scheduledNext = summary.plannedVisits.find((visit) => visit.appointmentDate) ?? null;

  const schedule = async (plannedVisitId: number) => {
    if (scheduleBusy) return;
    setScheduleBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/planned-visits/${plannedVisitId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: scheduleDate, time: scheduleTime }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(payload?.message ?? "تعذّر حجز الجلسة.");
        return;
      }
      setScheduleFor(null);
      setMessage("تم حجز الجلسة القادمة — العلاج يُقرأ من الخطة بلا إعادة إدخال.");
      onChanged();
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setScheduleBusy(false);
    }
  };

  const startPlannedVisit = async (plannedVisitId: number) => {
    setScheduleBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plannedVisitId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(payload?.message ?? "تعذّر بدء الزيارة.");
        return;
      }
      onVisitStarted();
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      setScheduleBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {message ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-800">
          {message}
        </p>
      ) : null}

      {summary.alerts.length > 0 ? (
        <ul className="space-y-1.5">
          {summary.alerts.map((alert, index) => (
            <li key={index} className={`rounded-xl border px-3 py-2 text-xs font-bold ${SEVERITY_STYLE[alert.severity]}`}>
              {alert.text}
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        * وصولٌ سريع للتقويم والأشعة من أول شاشة (طلب المالك): العين تجدهما هنا
        * قبل فتح أي تبويب — والتقويم يظهر حتى بلا حالة قائمة لأن فتحها يبدأ منه.
        */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onGoToTab("treatment")}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50">
          📐 التقويم
          {summary.counts.orthoCase ? (
            <span className="mr-1.5 rounded-full bg-sky-100 px-1.5 text-[10px] font-extrabold text-sky-700">حالة قائمة</span>
          ) : null}
        </button>
        <button type="button" onClick={() => onGoToTab("files")}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50">
          🗂️ الأشعة والمستندات
          {summary.counts.documents > 0 ? (
            <span className="mr-1.5 rounded-full bg-sky-100 px-1.5 text-[10px] font-extrabold text-sky-700">
              {summary.counts.documents}
            </span>
          ) : null}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* الموعد القادم */}
        <div className={`rounded-2xl border p-4 ${summary.nextAppointment ? "border-sky-300 bg-sky-50/40" : "border-slate-200 bg-white"}`}>
          <span className="text-xs font-bold text-slate-500">الموعد القادم</span>
          <p className="mt-1.5 text-sm font-extrabold text-navy-900">
            {summary.nextAppointment
              ? `${friendlyDate(summary.nextAppointment.date)} · ${friendlyTime(summary.nextAppointment.time)}`
              : "لا يوجد موعد قادم"}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {summary.nextAppointment
              ? `${getAppointmentTypeLabel(summary.nextAppointment.appointmentType) ?? "زيارة"}${summary.nextAppointment.note ? ` · ${summary.nextAppointment.note}` : ""}`
              : `الجلسات المتبقّية: ${summary.plannedVisits.length} — جدولها من هنا`}
          </p>
        </div>

        {/* آخر زيارة */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <span className="text-xs font-bold text-slate-500">آخر زيارة</span>
          <p className="mt-1.5 text-sm font-extrabold text-navy-900">
            {summary.lastVisit ? friendlyDateLong(summary.lastVisit.date) : "لا زيارات سابقة"}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {summary.lastVisit
              ? summary.lastVisit.proceduresSummary ?? summary.lastVisit.treatmentDone ?? "زيارة كشف"
              : `إجمالي الزيارات: ${summary.counts.visits}`}
          </p>
        </div>

        {/* الخطة النشطة */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-500">خطة العلاج النشطة</span>
            {primaryPlan && !primaryPlan.consentAt ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                مسوّدة — لم يوافق المريض
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-sm font-extrabold text-navy-900">
            {primaryPlan ? primaryPlan.title : "لا خطة جارية"}
          </p>
          {primaryPlan ? (
            <>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${Math.min(100, Math.round((primaryPlan.doneItems / Math.max(1, primaryPlan.itemsCount)) * 100))}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {primaryPlan.doneItems} من {primaryPlan.itemsCount} إجراءات ·
                باقي علاج {formatMoney(primaryPlan.remainingMinor, base)}
                {primaryPlan.specialty ? ` · ${primaryPlan.specialty}` : ""}
              </p>
            </>
          ) : (
            <p className="mt-0.5 text-[11px] text-slate-500">أنشئ خطة من تبويب العلاج</p>
          )}
        </div>

        {/* الجلسة التالية المخططة */}
        <div className={`rounded-2xl border p-4 ${nextPlanned ? "border-navy-200 bg-navy-50/40" : "border-slate-200 bg-white"}`}>
          <span className="text-xs font-bold text-slate-500">الجلسة التالية المخططة</span>
          <p className="mt-1.5 text-sm font-extrabold text-navy-900">
            {nextPlanned ?? scheduledNext
              ? (nextPlanned ?? scheduledNext)!.title
              : "لا جلسة مخطَّطة"}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {nextPlanned ?? scheduledNext
              ? `${PLANNED_VISIT_STATUS_LABEL[(nextPlanned ?? scheduledNext)!.status]} · ${(nextPlanned ?? scheduledNext)!.durationMinutes} دقيقة`
              : "تُقترح تلقائيًا بعد إنهاء كل زيارة"}
          </p>
        </div>
      </div>

      {/* جدولة الجلسة / بدؤها — تاريخ ووقت فقط، والعلاج من الخطة */}
      {summary.plannedVisits.length > 0 && !summary.openVisit ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="الجلسات المخطَّطة">
          <h3 className="mb-2 text-xs font-extrabold text-navy-900">
            الجلسات المخطَّطة ({summary.plannedVisits.length})
          </h3>
          <ul className="space-y-2">
            {summary.plannedVisits.map((visit) => (
              <li key={visit.id} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-navy-900">
                      {visit.title}
                      {visit.planTitle ? <span className="text-[11px] font-normal text-slate-500"> · {visit.planTitle}</span> : null}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {PLANNED_VISIT_STATUS_LABEL[visit.status]} · {visit.durationMinutes} دقيقة
                      {visit.doctorName ? ` · ${visit.doctorName}` : ""}
                      {visit.appointmentDate ? ` · محجوزة ${friendlyDate(visit.appointmentDate)} ${visit.appointmentTime}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    {!visit.appointmentDate && scheduleFor !== visit.id ? (
                      <button
                        type="button"
                        onClick={() => setScheduleFor(visit.id)}
                        className="rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-navy-50"
                      >
                        جدولها
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void startPlannedVisit(visit.id)}
                      disabled={scheduleBusy}
                      className="rounded-xl bg-brand-orange px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      ابدأ الزيارة
                    </button>
                  </div>
                </div>

                {scheduleFor === visit.id ? (
                  <div className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-2.5">
                    <label className="text-[11px] font-bold text-slate-600">
                      التاريخ
                      <input type="date" value={scheduleDate}
                        onChange={(event) => setScheduleDate(event.target.value)}
                        className="mt-1 block w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
                    </label>
                    <label className="text-[11px] font-bold text-slate-600">
                      الوقت
                      <input type="time" value={scheduleTime}
                        onChange={(event) => setScheduleTime(event.target.value)}
                        className="mt-1 block w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-xs" />
                    </label>
                    <button type="button" onClick={() => void schedule(visit.id)} disabled={scheduleBusy}
                      className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">
                      {scheduleBusy ? "جارٍ الحجز…" : "احجز"}
                    </button>
                    <button type="button" onClick={() => setScheduleFor(null)}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600">
                      إلغاء
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* الحساب — للمخوّل ماليًا فقط؛ الخادم أرسل الرصيد لمن يملكه */}
      {financial ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="الحساب">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-extrabold text-navy-900">الحساب</h3>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setCollectOpen(true)}
                className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white">
                تحصيل دفعة
              </button>
              <a href={`/print/statement/${patientId}`} target="_blank" rel="noopener"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800">
                كشف حساب
              </a>
              <button type="button" onClick={() => onGoToTab("account")}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800">
                تفاصيل الحركات
              </button>
            </div>
          </div>

          <p className={`mt-2 text-2xl font-black ${financial.balanceMinor > 0 ? "text-amber-600" : "text-emerald-600"}`}>
            {formatMoney(financial.balanceMinor, base)}
            <span className="mr-2 text-[11px] font-bold text-slate-500">
              {financial.balanceMinor > 0 ? "مستحق على المريض" : "الرصيد خالص"}
            </span>
          </p>

          {/*
            * الأرقام الستة (المواصفة §٢٤): المتفق عليه ≠ المديونية.
            * «باقي العلاج» عملٌ سيُعمل؛ «الرصيد» مالٌ يُطالَب به اليوم — وخلطهما
            * يجعل من وافق على خطةٍ لم تبدأ مدينًا.
            */}
          <dl className="mt-3 grid grid-cols-2 gap-1.5 text-center text-xs sm:grid-cols-3">
            {[
              ["قيمة العلاج المتفق عليه", financial.agreedMinor],
              ["تم تنفيذ علاج", financial.treatmentDoneMinor],
              ["باقي علاج", financial.remainingTreatmentMinor],
              ["تم فوترة", financial.invoicedMinor],
              ["تم دفع", financial.paidMinor],
              ["المديونية الحالية", financial.balanceMinor],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-xl bg-slate-50 px-2 py-2">
                <dt className="text-[10px] font-bold text-slate-500">{label}</dt>
                <dd className="mt-0.5 font-extrabold text-navy-900">{formatMoney(value as number, base)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {lastReceipt ? (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-center">
          <p className="mb-2 text-sm font-bold text-emerald-800">سُجّلت الدفعة.</p>
          <a href={`/print/receipt/${lastReceipt}`} target="_blank" rel="noopener"
            onClick={() => setLastReceipt(null)}
            className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">
            اطبع السند
          </a>
        </div>
      ) : null}

      {/* الخط الزمني الموحَّد (§٢٩-٣٠) — يُحمَّل عند فتحه، والفلترة تُجيب تاريخ
          العلاج وتاريخ المال من مكان واحد. */}
      <PatientTimeline patientId={patientId} base={base} />

      <CollectPaymentModal
        patientId={patientId}
        patientName={patientName}
        isOpen={collectOpen}
        onClose={() => setCollectOpen(false)}
        onSuccess={(paymentId) => {
          setCollectOpen(false);
          setLastReceipt(paymentId);
          onChanged();
        }}
        suggestedMinor={primaryPlan?.overdueMinor && primaryPlan.overdueMinor > 0 ? primaryPlan.overdueMinor : null}
        contextLabel={
          financial && financial.balanceMinor > 0
            ? `الرصيد الحالي المستحق: ${formatMoney(financial.balanceMinor, base)}`
            : null
        }
      />
    </div>
  );
}
