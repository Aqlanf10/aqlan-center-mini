"use client";

import { useEffect, useState } from "react";
import type { PatientAppointmentReadVisibility } from "@/lib/appointment-read-scope";
import { isConfirmedUnscheduled, workflowAppointmentEmptyText, workflowCalendar, workflowCalendarAlertVisible } from "@/lib/patient-workflow-calendar";
import { workflowDocuments, WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE } from "@/lib/patient-workflow-documents";
import { ReceiptCorrectionLauncher } from "@/components/ReceiptCorrectionLauncher";
import { CURRENCIES, CURRENCY_LABEL, formatMoney, type Currency } from "@/lib/money";
import { friendlyDate, friendlyDateLong, friendlyTime } from "@/lib/reminders";
import { getAppointmentTypeLabel } from "@/lib/schedule";
import { PLANNED_VISIT_STATUS_LABEL, type PlannedVisitStatus } from "@/lib/workflow";
import { CollectPaymentModal } from "../CollectPaymentModal";
import { PortalInviteRow } from "../PortalInviteRow";
import { PatientTimeline } from "./PatientTimeline";
import { PatientIntakeHistory } from "./PatientIntakeHistory";
import { useSession } from "../SessionProvider";

/**
 * تبويب الملخص — «ما وضع هذا المريض، وما المطلوب مني الآن؟» (المواصفة §٥).
 *
 * يجيب فورًا: الموعد القادم، وآخر زيارة، والخطة النشطة وتقدّمها، والجلسة التالية،
 * والحساب **للمخوّل ماليًا فقط** (الملخص يصله بلا أرصدة من الخادم أصلًا)، والتنبيهات.
 * ومن هنا تُجدول الجلسة المخطَّطة (تاريخٌ ووقت فقط) ويُفتح التحصيل الموحَّد.
 */

export interface WorkflowSummary {
  /** Explicit server capability; withheld plans are not an empty clinical record. */
  planVisible: boolean;
  /** Missing/legacy authority is unknown; document counts require explicit read access. */
  documentsVisible?: boolean | null;
  /** Missing/legacy authority is unknown, not an empty calendar. */
  appointmentVisibility?: PatientAppointmentReadVisibility;
  openVisit: { id: number; status: string; chair: number | null; arrivedAt: string; plannedTitle: string | null } | null;
  lastVisit: { id: number; date: string; treatmentDone: string | null; proceduresSummary: string | null; nextPlan: string | null } | null;
  nextAppointment: {
    id: number; date: string; time: string; durationMinutes: number;
    appointmentType: string | null; note: string | null; status: string;
  } | null;
  activePlans: {
    id: number; title: string; specialty: string | null; primaryDoctorName: string | null;
    consentAt: string | null; itemsCount: number; doneItems: number;
    /** null = withheld, never a zero-balance statement. */
    totalMinor: number | null; doneMinor: number | null; remainingMinor: number | null;
    nextDueDate: string | null; overdueMinor: number | null;
    financialVisible?: boolean;
    /* (TD-05) عملة اتفاق الخطة. */
    baseCurrency?: "YER" | "SAR" | "USD";
  }[];
  plannedVisits: {
    id: number; planTitle: string | null; sequence: number; title: string;
    doctorName: string | null; durationMinutes: number; status: PlannedVisitStatus;
    appointmentId?: number | null; appointmentVisibility?: PatientAppointmentReadVisibility;
    appointmentDate: string | null; appointmentTime: string | null; note: string | null;
    planId?: number | null; doctorId?: number | null; visitId?: number | null; createdAt?: string;
  }[];
  counts: { visits: number; openLabOrders: number; documents: number | null; orthoCase: boolean };
  financial: {
    balanceMinor: number; invoicedMinor: number; paidMinor: number; openingMinor: number;
    agreedMinor: number | null; treatmentDoneMinor: number | null; remainingTreatmentMinor: number | null;
    agreementPaidMinor?: number | null; agreementRemainingMinor?: number | null;
    /* (TD-05) نفس الحقول لكل عملةٍ ذات نشاط — المفرد هو دلو العملة الأساسية. */
    byCurrency?: Record<"YER" | "SAR" | "USD", {
      balanceMinor: number; invoicedMinor: number; paidMinor: number; openingMinor: number;
      agreedMinor: number | null; treatmentDoneMinor: number | null; remainingTreatmentMinor: number | null;
      agreementPaidMinor?: number | null; agreementRemainingMinor?: number | null;
    }>;
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
  patientNumber,
  patientPhone,
  base,
  onVisitStarted,
  onChanged,
  onGoToTab,
}: {
  summary: WorkflowSummary;
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
  const session = useSession();
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

  const financial = summary.canSeeFinancial ? summary.financial : null;
  // Financial reading is not collection authority. Cashier sessions cannot
  // open this clinical workspace; the payment API independently enforces both.
  const canCollect = summary.canSeeFinancial && (session?.role === "admin" || session?.role === "reception");
  const planVisible = summary.planVisible === true;
  const primaryPlan = planVisible ? summary.activePlans[0] ?? null : null;
  const canSeePlanFinancial = planVisible && summary.canSeeFinancial && primaryPlan?.financialVisible !== false;
  const documents = workflowDocuments(summary);
  const calendar = workflowCalendar(summary);
  const nextAppointment = calendar.nextAppointment;
  const alerts = summary.alerts.filter((alert) => workflowCalendarAlertVisible(alert.kind, calendar.appointmentVisibility));
  const plannedVisits = planVisible ? calendar.plannedVisits : [];
  // Clinical sequence/status survive a withheld calendar reference.
  const nextPlanned = plannedVisits[0] ?? null;
  const schedulableIds = plannedVisits.filter(isConfirmedUnscheduled).map((visit) => visit.id).join(",");
  useEffect(() => {
    if (scheduleFor !== null && !schedulableIds.split(",").includes(String(scheduleFor))) setScheduleFor(null);
  }, [scheduleFor, schedulableIds]);

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

      {alerts.length > 0 ? (
        <ul className="space-y-1.5">
          {alerts.map((alert, index) => (
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
        <button type="button" onClick={() => onGoToTab("files")} data-testid="summary-open-files"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-navy-800 hover:bg-slate-50">
          🗂️ الأشعة والمستندات
          {documents.documents !== null ? (
            <span aria-label={`عدد المستندات غير المحذوفة: ${documents.documents}`}
              className="mr-1.5 rounded-full bg-sky-100 px-1.5 text-[10px] font-extrabold text-sky-700">
              {documents.documents}
            </span>
          ) : <span className="mr-1.5 text-[10px] text-slate-500">{WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE}</span>}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* الموعد القادم */}
        <div className={`rounded-2xl border p-4 ${nextAppointment ? "border-sky-300 bg-sky-50/40" : "border-slate-200 bg-white"}`}>
          <span className="text-xs font-bold text-slate-500">{calendar.appointmentVisibility === "scoped" ? "الموعد القادم الظاهر" : "الموعد القادم"}</span>
          <p className="mt-1.5 text-sm font-extrabold text-navy-900">
            {nextAppointment
              ? `${friendlyDate(nextAppointment.date)} · ${friendlyTime(nextAppointment.time)}`
              : workflowAppointmentEmptyText(calendar.appointmentVisibility)}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {nextAppointment
              ? `${getAppointmentTypeLabel(nextAppointment.appointmentType) ?? "زيارة"}${nextAppointment.note ? ` · ${nextAppointment.note}` : ""}`
              : planVisible ? `الجلسات المخططة المتبقّية: ${plannedVisits.length}` : "الجلسات المخططة غير متاحة لهذه الصلاحية"}
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
            {!planVisible ? "غير متاح لهذه الصلاحية" : primaryPlan ? primaryPlan.title : "لا خطة جارية"}
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
                {primaryPlan.doneItems} من {primaryPlan.itemsCount} إجراءات
                {canSeePlanFinancial && primaryPlan.remainingMinor !== null
                  ? ` · باقي علاج ${formatMoney(primaryPlan.remainingMinor, primaryPlan.baseCurrency ?? base)}` : ""}
                {primaryPlan.specialty ? ` · ${primaryPlan.specialty}` : ""}
              </p>
            </>
          ) : planVisible ? (
            <p className="mt-0.5 text-[11px] text-slate-500">أنشئ خطة من تبويب العلاج</p>
          ) : null}
        </div>

        {/* الجلسة التالية المخططة */}
        <div className={`rounded-2xl border p-4 ${nextPlanned ? "border-navy-200 bg-navy-50/40" : "border-slate-200 bg-white"}`}>
          <span className="text-xs font-bold text-slate-500">الجلسة التالية المخططة</span>
          <p className="mt-1.5 text-sm font-extrabold text-navy-900">
            {!planVisible ? "غير متاح لهذه الصلاحية" : nextPlanned
              ? nextPlanned.title
              : "لا جلسة مخطَّطة"}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {!planVisible ? "لم يُحمّل سياق الخطط ضمن الصلاحية الحالية" : nextPlanned
              ? `${PLANNED_VISIT_STATUS_LABEL[nextPlanned.status]} · ${nextPlanned.durationMinutes} دقيقة`
              : "تُقترح تلقائيًا بعد إنهاء كل زيارة"}
          </p>
        </div>
      </div>

      {/* جدولة الجلسة / بدؤها — تاريخ ووقت فقط، والعلاج من الخطة */}
      {planVisible && plannedVisits.length > 0 && !summary.openVisit ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="الجلسات المخطَّطة">
          <h3 className="mb-2 text-xs font-extrabold text-navy-900">
            الجلسات المخطَّطة ({plannedVisits.length})
          </h3>
          <ul className="space-y-2">
            {plannedVisits.map((visit) => (
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
                      {visit.appointmentDate ? ` · محجوزة ${friendlyDate(visit.appointmentDate)} ${visit.appointmentTime}`
                        : visit.appointmentVisibility === "all" ? "" : " · تفاصيل الموعد غير متاحة في هذه القراءة"}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    {isConfirmedUnscheduled(visit) && scheduleFor !== visit.id ? (
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

                {isConfirmedUnscheduled(visit) && scheduleFor === visit.id ? (
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
              {canCollect ? <button type="button" onClick={() => setCollectOpen(true)}
                className="rounded-xl bg-brand-orange px-4 py-2 text-xs font-extrabold text-white">
                تحصيل دفعة
              </button> : null}
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
            return row && (Object.values(row).some((value) => typeof value === "number" && value !== 0) || currency === base && !financial.byCurrency);
          }).map((currency) => {
            const row = financial.byCurrency?.[currency] ?? financial;
            return <div key={currency} className="mt-3 rounded-xl border border-slate-200 p-3">
              <p className="text-xs font-bold">{CURRENCY_LABEL[currency]}</p>
              <p className="mt-1 text-lg font-black">
                {row.balanceMinor > 0 ? `المستحق الحالي: ${formatMoney(row.balanceMinor, currency)}` : row.balanceMinor < 0 ? `رصيد لصالح المريض: ${formatMoney(-row.balanceMinor, currency)}` : "المستحق الحالي مسدّد"}
                {planVisible && (row.agreementRemainingMinor ?? 0) > 0 ? <span className="block text-sm text-amber-700">متبقّي من اتفاق العلاج: {formatMoney(row.agreementRemainingMinor!, currency)}</span> : null}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-1.5 text-center text-xs sm:grid-cols-3">
                {[
                  ...(planVisible ? [
                    ["قيمة العلاج المتفق عليه", row.agreedMinor],
                    ["المسدّد من الاتفاق", row.agreementPaidMinor ?? 0],
                    ["المتبقي من الاتفاق", row.agreementRemainingMinor ?? 0],
                    ["تم تنفيذ علاج", row.treatmentDoneMinor],
                    ["علاج غير منفّذ", row.remainingTreatmentMinor],
                  ] : []),
                  ["تم فوترة", row.invoicedMinor],
                  ["تم دفع", row.paidMinor],
                  ["المديونية الحالية", row.balanceMinor],
                ].filter(([, value]) => typeof value === "number").map(([label, value]) => <div key={label as string} className="rounded-xl bg-slate-50 px-2 py-2">
                  <dt className="text-[10px] font-bold text-slate-500">{label}</dt>
                  <dd className="mt-0.5 font-extrabold text-navy-900">{formatMoney(value as number, currency)}</dd>
                </div>)}
              </dl>
            </div>;
          })}
          {!CURRENCIES.some((currency) => financial.byCurrency?.[currency] && Object.values(financial.byCurrency[currency]).some((value) => typeof value === "number" && value !== 0)) && financial.byCurrency ? <p className="mt-2 font-bold">{planVisible ? "لا مبالغ مستحقة ولا اتفاق متبقٍّ" : "لا مبالغ مستحقة في الحساب الظاهر"}</p> : null}
          {!planVisible ? <p className="mt-2 text-xs text-slate-500">تفاصيل اتفاق العلاج غير متاحة لهذه الصلاحية</p> : null}
        </section>
      ) : null}

      {lastReceipt && canCollect ? (
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

      {canCollect ? <CollectPaymentModal
        patientId={patientId}
        patientName={patientName}
        isOpen={collectOpen}
        onClose={() => setCollectOpen(false)}
        onSuccess={(paymentId) => {
          setCollectOpen(false);
          setLastReceipt(paymentId);
          onChanged();
        }}
        suggestedMinor={canSeePlanFinancial && primaryPlan?.overdueMinor && primaryPlan.overdueMinor > 0 ? primaryPlan.overdueMinor : null}
        /* (TD-05 owner review) المتأخر بعملة خطة الاتفاق — يُقترح بعملته لا بعملة
           الدفاتر، فلا يُقبض نصيبُ خطةٍ دولاريةٍ وكأنه يمنيّ. */
        suggestedCurrency={primaryPlan?.baseCurrency ?? null}
        contextLabel={
          financial && financial.balanceMinor > 0
            ? `الرصيد الحالي المستحق: ${formatMoney(financial.balanceMinor, base)}`
            : null
        }
      /> : null}
    </div>
  );
}
