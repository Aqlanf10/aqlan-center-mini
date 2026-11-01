"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { hasPatientFinancialActivity, type PatientWorkflowFinancialBucket } from "@/lib/patient-agreement-summary";
import type { ClinicalProgressView } from "@/lib/historical-clinical-projection";
import { HistoricalClinicalNote } from "../HistoricalClinicalNote";
import type { AssessmentCase, LegacyCase } from "@/lib/patient-workflow-cases";
import { ReceiptCorrectionLauncher } from "@/components/ReceiptCorrectionLauncher";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import { friendlyDate, friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { addDays, clinicDateString, getAppointmentTypeLabel, toMinutes, type AppointmentStatus } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { PLANNED_VISIT_STATUS_LABEL, type PlannedVisitStatus } from "@/lib/workflow";
import { CollectPaymentModal } from "../CollectPaymentModal";
import { PortalInviteRow } from "../PortalInviteRow";
import { PatientTimeline } from "./PatientTimeline";
import { PatientIntakeHistory } from "./PatientIntakeHistory";

/**
 * تبويب الملخص — «ما وضع هذا المريض، وما المطلوب مني الآن؟» (المواصفة §٥).
 *
 * يجيب فورًا: الموعد القادم، وآخر زيارة، والخطة النشطة وتقدّمها، والجلسة التالية،
 * والحساب **للمخوّل ماليًا فقط** (الملخص يصله بلا أرصدة من الخادم أصلًا)، والتنبيهات.
 * ومن هنا تُجدول الجلسة المخطَّطة (تاريخٌ ووقت فقط) ويُفتح التحصيل الموحَّد.
 */

export interface WorkflowSummary {
  today?: string;
  timeZone?: string;
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
    nextDueDate: string | null; overdueMinor: number | null;
    /* (TD-05) عملة اتفاق الخطة. */
    baseCurrency?: "YER" | "SAR" | "USD";
    clinicalProgress?: ClinicalProgressView;
  }[];
  plannedVisits: {
    id: number; planTitle: string | null; sequence: number; title: string;
    doctorName: string | null; durationMinutes: number; status: PlannedVisitStatus;
    appointmentId: number | null; appointmentStatus: AppointmentStatus | null;
    canRebook: boolean; rebookBlockedReason: string | null; rebookGeneration: string;
    appointmentDate: string | null; appointmentTime: string | null; note: string | null;
  }[];
  counts: { visits: number; openLabOrders: number; documents: number; orthoCase: boolean };
  /** (INV-LINK D) حالاتٌ فتحتها فاتورة علاجية وتنتظر تقييم الطبيب. */
  assessmentCases?: AssessmentCase[];
  legacyCases?: LegacyCase[];
  financial: (PatientWorkflowFinancialBucket & {
    /* The compatibility view is the clinic base currency, never a currency sum. */
    byCurrency?: Record<Currency, PatientWorkflowFinancialBucket>;
  }) | null;
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
  patientNumber,
  patientPhone,
  base,
  onVisitStarted,
  onChanged,
  onGoToTab,
  workflowIsCurrent,
}: {
  summary: WorkflowSummary;
  workflowIsCurrent?: () => boolean;
  patientId: number;
  patientName: string;
  /** رقم الملف — مفتاح بوّابة المريض نصفه، وبطاقته المطبوعة تحمله كاملًا. */
  patientNumber: string;
  patientPhone: string | null;
  base: Currency;
  onVisitStarted: () => void;
  onChanged: () => void;
  onGoToTab: (tab: string) => void;
}) {
  const [scheduleFor, setScheduleFor] = useState<number | null>(null);
  const clinicToday = () => clinicDateString(new Date(), summary.timeZone ?? CLINIC_ZONE_FALLBACK);
  const [scheduleDate, setScheduleDate] = useState(() => addDays(summary.today ?? clinicToday(), 1));
  const [scheduleTime, setScheduleTime] = useState("16:00");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [rebookReason, setRebookReason] = useState("");
  const [rebookUncertain, setRebookUncertain] = useState(false);
  const [scheduleError, setScheduleError] = useState<{ field?: "date" | "time" | "reason"; text: string } | null>(null);
  const scheduleInFlight = useRef(false);
  const [rebookAttemptVisitId, setRebookAttemptVisitId] = useState<number | null>(null);
  const rebookAttempt = useRef<{ plannedVisitId: number; body: string; uncertain: boolean } | null>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const timeField = useRef<HTMLInputElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const lifetime = useRef({ patientId, active: false });
  useLayoutEffect(() => {
    const owner = { patientId, active: true };
    lifetime.current = owner;
    return () => { owner.active = false; };
  }, [patientId]);
  const [collectOpen, setCollectOpen] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const financial = summary.canSeeFinancial ? summary.financial : null;
  const primaryPlan = summary.activePlans[0] ?? null;
  const nextPlanned = summary.plannedVisits.find((visit) => !visit.appointmentDate) ?? null;
  const scheduledNext = summary.plannedVisits.find((visit) => visit.appointmentDate) ?? null;
  const nextSession = nextPlanned ?? scheduledNext;
  const plannedStatusLabel = (visit: WorkflowSummary["plannedVisits"][number]) =>
    visit.appointmentStatus === "no_show" || visit.appointmentStatus === "cancelled"
      ? visit.canRebook ? "تحتاج إعادة حجز" : "تحتاج مراجعة قبل إعادة الحجز"
      : PLANNED_VISIT_STATUS_LABEL[visit.status];
  const currentWorkflow = () => lifetime.current.active && lifetime.current.patientId === patientId
    && workflowIsCurrent?.() !== false;

  const openSchedule = (plannedVisitId: number) => {
    if (scheduleInFlight.current || rebookAttempt.current?.uncertain || !currentWorkflow()) return;
    setScheduleFor(plannedVisitId);
    setScheduleDate(addDays(clinicToday(), 1));
    setScheduleTime("16:00");
    setRebookReason("");
    setScheduleError(null);
    setMessage(null);
  };

  const rebook = async (visit: WorkflowSummary["plannedVisits"][number]) => {
    if (scheduleInFlight.current || !currentWorkflow()) return;
    const previous = rebookAttempt.current;
    if (previous && previous.plannedVisitId !== visit.id) return;
    if (!previous) {
      if (!visit.canRebook || !visit.appointmentId) return;
      if (!/^[a-f0-9]{32}$/.test(visit.rebookGeneration)) {
        setScheduleError({ text: "تعذّر التحقق من نسخة الجلسة. حدّث الملف قبل إعادة الحجز." });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduleDate) || addDays(scheduleDate, 0) !== scheduleDate || scheduleDate < clinicToday()) {
        setScheduleError({ field: "date", text: "اختر تاريخًا صحيحًا لا يسبق اليوم بتوقيت العيادة." });
        dateField.current?.focus(); return;
      }
      if (!/^\d{2}:\d{2}$/.test(scheduleTime) || toMinutes(scheduleTime) === null) {
        setScheduleError({ field: "time", text: "أدخل وقتًا صحيحًا للحجز." });
        timeField.current?.focus(); return;
      }
      if (rebookReason.trim().length < 3 || rebookReason.trim().length > 500) {
        setScheduleError({ field: "reason", text: "اكتب سبب إعادة الحجز من 3 أحرف على الأقل، بحد أقصى 500 حرف." });
        reasonField.current?.focus(); return;
      }
      setRebookAttemptVisitId(visit.id);
      rebookAttempt.current = { plannedVisitId: visit.id, uncertain: false, body: JSON.stringify({
        expectedAppointmentId: visit.appointmentId, expectedGeneration: visit.rebookGeneration,
        date: scheduleDate, time: scheduleTime,
        reason: rebookReason.trim(), requestId: crypto.randomUUID(),
      }) };
    }
    const attempt = rebookAttempt.current!;
    const owner = lifetime.current;
    const isCurrent = () => owner.active && lifetime.current === owner && workflowIsCurrent?.() !== false;
    scheduleInFlight.current = true;
    setScheduleBusy(true);
    setScheduleError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/planned-visits/${visit.id}/rebook`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: attempt.body,
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => null);
      if (!isCurrent()) {
        attempt.uncertain = true;
        if (owner.active && lifetime.current === owner) {
          setRebookUncertain(true);
          setScheduleError({ text: "تغيّرت بيانات الملف أثناء الطلب. حدّث الملف للتحقق من نتيجة الحجز قبل المتابعة." });
        }
        return;
      }
      if (response.ok && Number.isSafeInteger(payload?.appointmentId) && payload.appointmentId > 0) {
        rebookAttempt.current = null;
        setRebookAttemptVisitId(null);
        setRebookUncertain(false);
        setScheduleFor(null);
        setMessage("تمت إعادة حجز الجلسة. بقي الموعد السابق وحالته محفوظين في السجل.");
        onChanged();
        return;
      }
      if (!response.ok && response.status < 500 && !attempt.uncertain) {
        rebookAttempt.current = null;
        setRebookAttemptVisitId(null);
        setScheduleError({ text: payload?.message ?? "لم تُقبل إعادة الحجز. راجع الموعد والصلاحية ثم حاول مجددًا." });
        return;
      }
      attempt.uncertain = true;
      setRebookUncertain(true);
      setScheduleError({ text: "تعذّر تأكيد نتيجة إعادة الحجز. أعد الطلب نفسه أو حدّث الملف للتحقق قبل تغيير البيانات." });
    } catch {
      attempt.uncertain = true;
      if (owner.active && lifetime.current === owner) {
        setRebookUncertain(true);
        setScheduleError({ text: "انقطع الرد وقد يكون الحجز قد تم. أعد الطلب نفسه أو حدّث الملف للتحقق قبل تغيير البيانات." });
      }
    } finally {
      scheduleInFlight.current = false;
      if (owner.active && lifetime.current === owner) setScheduleBusy(false);
    }
  };

  const schedule = async (plannedVisitId: number) => {
    if (scheduleInFlight.current || rebookAttempt.current || !currentWorkflow()) return;
    scheduleInFlight.current = true;
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
      scheduleInFlight.current = false;
      setScheduleBusy(false);
    }
  };

  const startPlannedVisit = async (plannedVisitId: number) => {
    if (scheduleInFlight.current || rebookAttempt.current || !currentWorkflow()) return;
    const visit = summary.plannedVisits.find((item) => item.id === plannedVisitId);
    if (!visit || visit.appointmentStatus === "no_show" || visit.appointmentStatus === "cancelled") return;
    scheduleInFlight.current = true;
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
      scheduleInFlight.current = false;
      setScheduleBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {message ? (
        <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-800">
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

      <PatientIntakeHistory patientId={patientId} />

      {/*
        * بطاقة الملف ودعوة البوّابة (من مستودع الوكيل الآخر) — هنا حيث تبدأ
        * رحلة الاستقبال مع المريض: البطاقة في جيبه تختصر البحث إلى رقم،
        * والرابط على جوّاله يعطيه مواعيده بنفسه.
        */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <a href={`/print/patient-card/${patientId}`} target="_blank" rel="noopener"
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50">
            🪪 بطاقة الملف
          </a>
        </div>
        <PortalInviteRow patientNumber={patientNumber} phone={patientPhone} />
      </div>

      {/*
        * وصولٌ سريع للتقويم والأشعة من أول شاشة (طلب المالك): العين تجدهما هنا
        * قبل فتح أي تبويب — والتقويم يظهر حتى بلا حالة قائمة لأن فتحها يبدأ منه.
        */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onGoToTab("ortho")} data-testid="summary-open-ortho"
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

      <div className="grid gap-3 sm:grid-cols-2" data-testid="summary-current-work">
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
                موافقة العلاج لم تُسجّل
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-sm font-extrabold text-navy-900">
            {primaryPlan ? primaryPlan.title : "لا خطة جارية"}
          </p>
          {primaryPlan ? (
            <>
              {primaryPlan.clinicalProgress?.historicalItems ? (
                <p className="mt-2 text-[11px] text-slate-600"><HistoricalClinicalNote progress={primaryPlan.clinicalProgress} currency={primaryPlan.baseCurrency ?? base} /></p>
              ) : <>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-emerald-500"
                  style={{ width: `${Math.min(100, Math.round((primaryPlan.doneItems / Math.max(1, primaryPlan.itemsCount)) * 100))}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {primaryPlan.doneItems} من {primaryPlan.itemsCount} إجراءات ·
                باقي علاج {formatMoney(primaryPlan.remainingMinor, primaryPlan.baseCurrency ?? base)}
                {primaryPlan.specialty ? ` · ${primaryPlan.specialty}` : ""}
              </p>
              </>}
            </>
          ) : (
            <p className="mt-0.5 text-[11px] text-slate-500">أنشئ خطة من تبويب العلاج</p>
          )}
        </div>

        {/* الجلسة التالية المخططة */}
        <div className={`rounded-2xl border p-4 ${nextPlanned ? "border-navy-200 bg-navy-50/40" : "border-slate-200 bg-white"}`}>
          <span className="text-xs font-bold text-slate-500">الجلسة التالية المخططة</span>
          <p className="mt-1.5 text-sm font-extrabold text-navy-900">
            {nextSession
              ? nextSession.title
              : "لا جلسة مخطَّطة"}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {nextSession
              ? `${plannedStatusLabel(nextSession)} · ${nextSession.durationMinutes} دقيقة`
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
            {summary.plannedVisits.map((visit) => {
              const terminalAppointment = visit.appointmentStatus === "no_show" || visit.appointmentStatus === "cancelled";
              const isRebooking = terminalAppointment || rebookAttemptVisitId === visit.id;
              const errorId = `planned-visit-${visit.id}-error`;
              const historyId = `planned-visit-${visit.id}-history`;
              return (
              <li key={visit.id} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-navy-900">
                      {visit.title}
                      {visit.planTitle ? <span className="text-[11px] font-normal text-slate-500"> · {visit.planTitle}</span> : null}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {plannedStatusLabel(visit)} · {visit.durationMinutes} دقيقة
                      {visit.doctorName ? ` · ${visit.doctorName}` : ""}
                      {visit.appointmentDate ? ` · ${terminalAppointment ? "الموعد السابق" : "محجوزة"} ${friendlyDate(visit.appointmentDate)} ${visit.appointmentTime}` : ""}
                    </p>
                    {terminalAppointment ? <p id={historyId} className="mt-1 text-xs font-bold text-amber-900">
                      {visit.appointmentStatus === "no_show" ? "لم يحضر الموعد السابق." : "أُلغي الموعد السابق."} يبقى الموعد السابق وحالته محفوظين؛ إعادة الحجز تنشئ موعدًا جديدًا ولا تبدأ زيارة.
                    </p> : null}
                    {terminalAppointment && !visit.canRebook && visit.rebookBlockedReason ? (
                      <p className="mt-1 text-xs text-slate-600">{visit.rebookBlockedReason}</p>
                    ) : null}
                  </div>
                  <div className="flex gap-1.5">
                    {!terminalAppointment && !visit.appointmentDate && scheduleFor !== visit.id ? (
                      <button
                        type="button"
                        onClick={() => openSchedule(visit.id)}
                        disabled={scheduleBusy || rebookUncertain}
                        className="cursor-pointer rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-navy-50 active:bg-navy-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        جدولها
                      </button>
                    ) : null}
                    {terminalAppointment && visit.canRebook && scheduleFor !== visit.id ? (
                      <button type="button" onClick={() => openSchedule(visit.id)} disabled={scheduleBusy || rebookUncertain}
                        aria-describedby={historyId}
                        className="cursor-pointer rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-navy-50 active:bg-navy-100 disabled:cursor-not-allowed disabled:opacity-50">
                        إعادة حجز
                      </button>
                    ) : null}
                    {!terminalAppointment ? <button
                      type="button"
                      onClick={() => void startPlannedVisit(visit.id)}
                      disabled={scheduleBusy || rebookUncertain}
                      className="cursor-pointer rounded-xl bg-brand-orange px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      ابدأ الزيارة
                    </button> : null}
                  </div>
                </div>

                {scheduleFor === visit.id ? (
                  <form noValidate aria-label={isRebooking ? `إعادة حجز ${visit.title}` : `حجز ${visit.title}`}
                    aria-busy={scheduleBusy} onSubmit={(event) => {
                      event.preventDefault();
                      if (isRebooking) void rebook(visit); else void schedule(visit.id);
                    }}
                    className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-2.5">
                    <label className="text-[11px] font-bold text-slate-600">
                      التاريخ
                      <input ref={dateField} type="date" value={scheduleDate} min={clinicToday()} required
                        disabled={scheduleBusy || rebookUncertain}
                        aria-invalid={scheduleError?.field === "date"} aria-describedby={scheduleError ? errorId : undefined}
                        onChange={(event) => { if (!scheduleInFlight.current && !rebookAttempt.current?.uncertain) setScheduleDate(event.target.value); }}
                        className="mt-1 block w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-xs disabled:bg-slate-100" />
                    </label>
                    <label className="text-[11px] font-bold text-slate-600">
                      الوقت
                      <input ref={timeField} type="time" value={scheduleTime} required
                        disabled={scheduleBusy || rebookUncertain}
                        aria-invalid={scheduleError?.field === "time"} aria-describedby={scheduleError ? errorId : undefined}
                        onChange={(event) => { if (!scheduleInFlight.current && !rebookAttempt.current?.uncertain) setScheduleTime(event.target.value); }}
                        className="mt-1 block w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-xs disabled:bg-slate-100" />
                    </label>
                    {isRebooking ? <label className="w-full text-[11px] font-bold text-slate-600">
                      سبب إعادة الحجز
                      <textarea ref={reasonField} value={rebookReason} required minLength={3} maxLength={500} rows={3}
                        disabled={scheduleBusy || rebookUncertain}
                        aria-invalid={scheduleError?.field === "reason"} aria-describedby={scheduleError ? errorId : undefined}
                        onChange={(event) => { if (!scheduleInFlight.current && !rebookAttempt.current?.uncertain) setRebookReason(event.target.value); }}
                        className="mt-1 block w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 text-xs disabled:bg-slate-100" />
                      <span className="font-normal">مطلوب، من 3 إلى 500 حرف. لا تغيّر إعادة الحجز السجل السابق أو الحساب المالي.</span>
                    </label> : null}
                    {scheduleError ? <p id={errorId} role="alert" className="w-full text-xs font-bold text-amber-900">{scheduleError.text}</p> : null}
                    <button type="submit" disabled={scheduleBusy || (isRebooking && !rebookUncertain && !visit.canRebook)}
                      className="min-w-32 cursor-pointer rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white hover:bg-navy-700 active:bg-navy-900 disabled:cursor-not-allowed disabled:opacity-50">
                      {scheduleBusy ? "جارٍ الحجز…" : rebookUncertain ? "إعادة الطلب نفسه" : isRebooking ? "تأكيد إعادة الحجز" : "احجز"}
                    </button>
                    {rebookUncertain ? <button type="button" disabled={scheduleBusy} onClick={() => window.location.reload()}
                      className="cursor-pointer rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50">
                      تحديث الملف للتحقق
                    </button> : null}
                    <button type="button" disabled={scheduleBusy || rebookUncertain} onClick={() => {
                      if (!scheduleInFlight.current && !rebookAttempt.current) { setScheduleFor(null); setScheduleError(null); }
                    }}
                      className="cursor-pointer rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50">
                      إلغاء
                    </button>
                  </form>
                ) : null}
              </li>
            ); })}
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

          {CURRENCIES.filter((currency) => {
            const row = financial.byCurrency?.[currency] ?? (currency === base ? financial : null);
            return row && (hasPatientFinancialActivity(row) || currency === base && !financial.byCurrency);
          }).map((currency) => {
            const row = financial.byCurrency?.[currency] ?? financial;
            const agreementsVerified = row.approvedAgreements !== undefined && row.classicInstallments !== undefined
              && (!row.approvedAgreements || row.approvedAgreements.available);
            return <div key={currency} className="mt-3 rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-bold">{CURRENCY_LABEL[currency]}</p>
              <p className="mt-1 text-lg font-black">
                {!agreementsVerified ? `رصيد دفتر الحساب: ${formatMoney(row.balanceMinor, currency)} · ملخص الاتفاقات يحتاج تحقق` : row.balanceMinor > 0 ? `المستحق الحالي: ${formatMoney(row.balanceMinor, currency)}` : row.balanceMinor < 0 ? `رصيد لصالح المريض: ${formatMoney(-row.balanceMinor, currency)}` : "المستحق الحالي مسدّد"}
              </p>
              {row.approvedAgreements === undefined || row.classicInstallments === undefined
                ? <p role="status" className="mt-2 text-xs font-bold text-amber-700">ملخص الاتفاقات غير متاح؛ أعد تحميل بيانات الحساب.</p> : null}
              {row.approvedAgreements ? <div className="mt-3" data-testid="approved-agreement-summary" data-currency={currency}>
                <p className="text-xs font-bold">الاتفاقات المالية المعتمدة</p>
                {!row.approvedAgreements.available ? <p role="status" className="mt-1 text-xs font-bold text-amber-700">مصدر اتفاق معتمد يحتاج مراجعة؛ إجمالي المدفوع والمتبقي والمستحق حسب الجدول غير متاح حتى التحقق.</p> : null}
                <dl className="mt-2 grid grid-cols-2 gap-1.5 text-center text-xs sm:grid-cols-4">
                  {([
                    ["قيمة العلاج المعتمدة", row.approvedAgreements.totalMinor],
                    ["المسدّد من الاتفاق المعتمد", row.approvedAgreements.paidMinor],
                    ["المتبقي من الاتفاق المعتمد", row.approvedAgreements.remainingMinor],
                    ["المستحق حسب جدول الاتفاق", row.approvedAgreements.dueNowMinor],
                  ] as const).map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 px-2 py-2">
                    <dt className="text-[10px] font-bold text-slate-500">{label}</dt>
                    <dd className="mt-0.5 font-extrabold text-navy-900">{value === null ? "غير متاح حتى المراجعة" : formatMoney(value, currency)}</dd>
                  </div>)}
                </dl>
                <p className="mt-1 text-xs text-slate-500">{row.approvedAgreements.available
                  ? "الاتفاق المعتمد محسوب في رصيد الحساب؛ لا يُضاف إليه مرة أخرى. المدفوع يشمل أي سداد تاريخي موثّق عند مطابقة رصيد افتتاحي."
                  : "قيمة الاتفاق من الاعتماد المحفوظ؛ يلزم التحقق من مصدره قبل تأكيد المدفوع والمتبقي. لا تجمعها مع رصيد الحساب."}</p>
              </div> : null}
              {row.classicInstallments ? <div className="mt-3" data-testid="classic-installment-reference" data-currency={currency}>
                <p className="text-xs font-bold">مرجع خطط التقسيط غير المعتمدة مالياً</p>
                <dl className="mt-2 grid grid-cols-2 gap-1.5 text-center text-xs sm:grid-cols-3">
                  {([
                    ["قيمة خطة التقسيط", row.classicInstallments.totalMinor],
                    ["المحصّل عبر أقساطها", row.classicInstallments.paidMinor],
                    ["المتبقي المخطط للأقساط", row.classicInstallments.remainingMinor],
                  ] as const).map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 px-2 py-2">
                    <dt className="text-[10px] font-bold text-slate-500">{label}</dt>
                    <dd className="mt-0.5 font-extrabold text-navy-900">{formatMoney(value, currency)}</dd>
                  </div>)}
                </dl>
                <p className="mt-1 text-xs text-slate-500">المتبقي المخطط للأقساط ليس رصيد الحساب؛ المستحق يُقرأ من دفتر الحساب فقط.</p>
              </div> : null}
              <dl className="mt-3 grid grid-cols-2 gap-1.5 text-center text-xs sm:grid-cols-3">
                {[
                  ["القيمة المخططة للعلاج الجاري", row.agreedMinor],
                  [row.clinicalProgress?.historicalItems ? "تم تنفيذ علاج معروف خارج التاريخي" : "تم تنفيذ علاج", row.clinicalProgress?.historicalItems ? row.clinicalProgress.knownDoneMinor : row.treatmentDoneMinor],
                  [row.clinicalProgress?.historicalItems ? "باقي علاج معروف خارج التاريخي" : "علاج غير منفّذ", row.clinicalProgress?.historicalItems ? row.clinicalProgress.knownRemainingMinor : row.remainingTreatmentMinor],
                  ["تم فوترة", row.invoicedMinor],
                  ["تم دفع", row.paidMinor],
                  ["المديونية الحالية", row.balanceMinor],
                ].map(([label, value]) => <div key={label as string} className="rounded-xl bg-slate-50 px-2 py-2">
                  <dt className="text-[10px] font-bold text-slate-500">{label}</dt>
                  <dd className="mt-0.5 font-extrabold text-navy-900">{formatMoney(value as number, currency)}</dd>
                </div>)}
              </dl>
              {row.clinicalProgress?.historicalItems ? <p className="mt-2 text-xs text-slate-600"><HistoricalClinicalNote progress={row.clinicalProgress} currency={currency} /></p> : null}
            </div>;
          })}
          {!CURRENCIES.some((currency) => financial.byCurrency?.[currency] && hasPatientFinancialActivity(financial.byCurrency[currency])) && financial.byCurrency ? <p className="mt-2 font-bold">لا حركة مالية ولا خطط علاج في الملخص</p> : null}
        </section>
      ) : null}

      {lastReceipt ? (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-center">
          <p className="mb-2 text-sm font-bold text-emerald-800">سُجّلت الدفعة.</p>
          <div className="flex flex-wrap items-start justify-center gap-2">
            <a href={`/print/receipt/${lastReceipt}`} target="_blank" rel="noopener"
              onClick={() => setLastReceipt(null)}
              className="inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white">
              اطبع السند
            </a>
            {/* (RC-2) أُدخل المبلغ خطأً؟ يُصحَّح هنا فورًا — للمدير. */}
            <ReceiptCorrectionLauncher key={lastReceipt} paymentId={lastReceipt} patientId={patientId} label="المبلغ خطأ؟ صحّح السند"
              onDone={(_message, replacementId) => { setLastReceipt(replacementId); onChanged(); }} />
          </div>
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
        /* (TD-05 owner review) المتأخر بعملة خطة الاتفاق — يُقترح بعملته لا بعملة
           الدفاتر، فلا يُقبض نصيبُ خطةٍ دولاريةٍ وكأنه يمنيّ. */
        suggestedCurrency={primaryPlan?.baseCurrency ?? null}
        contextLabel={
          financial && financial.balanceMinor > 0
            ? `الرصيد الحالي المستحق: ${formatMoney(financial.balanceMinor, base)}`
            : null
        }
      />
    </div>
  );
}


