"use client";
import { useEffect, useRef, useState } from "react";
import { addDays, clinicDateString, toMinutes } from "@/lib/schedule";
import { friendlyDate } from "@/lib/reminders";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { PLANNED_VISIT_STATUS_LABEL } from "@/lib/workflow";
import type { WorkflowSummary } from "./SummaryTab";

export const plannedStatusLabel = (visit: WorkflowSummary["plannedVisits"][number]) =>
  visit.appointmentStatus === "no_show" || visit.appointmentStatus === "cancelled"
    ? visit.canRebook
      ? "تحتاج إعادة حجز"
      : "تحتاج مراجعة قبل إعادة الحجز"
    : PLANNED_VISIT_STATUS_LABEL[visit.status];

export function PlannedVisitBooking({
  summary,
  patientId,
  onChanged,
  onVisitStarted,
  workflowIsCurrent,
}: {
  summary: Pick<WorkflowSummary, "today" | "timeZone" | "plannedVisits">;
  patientId: number;
  onChanged: () => void;
  onVisitStarted?: () => void;
  workflowIsCurrent?: () => boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [scheduleFor, setScheduleFor] = useState<number | null>(null);
  const clinicToday = () => clinicDateString(new Date(), summary.timeZone ?? CLINIC_ZONE_FALLBACK);
  const [scheduleDate, setScheduleDate] = useState(() => addDays(summary.today ?? clinicToday(), 1));
  const [scheduleTime, setScheduleTime] = useState("16:00");
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [rebookReason, setRebookReason] = useState("");
  const [rebookUncertain, setRebookUncertain] = useState(false);
  const [scheduleError, setScheduleError] = useState<{ field?: "date" | "time" | "reason"; text: string } | null>(null);
  const scheduleInFlight = useRef(false);
  const rebookAttempt = useRef<{ plannedVisitId: number; body: string; uncertain: boolean } | null>(null);
  const dateField = useRef<HTMLInputElement>(null);
  const timeField = useRef<HTMLInputElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const lifetime = useRef({ patientId, active: true });
  if (lifetime.current.patientId !== patientId) {
    lifetime.current.active = false;
    lifetime.current = { patientId, active: true };
  }
  useEffect(() => {
    const owner = lifetime.current;
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [patientId]);
  const currentWorkflow = () =>
    lifetime.current.active && lifetime.current.patientId === patientId && workflowIsCurrent?.() !== false;

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
        dateField.current?.focus();
        return;
      }
      if (!/^\d{2}:\d{2}$/.test(scheduleTime) || toMinutes(scheduleTime) === null) {
        setScheduleError({ field: "time", text: "أدخل وقتًا صحيحًا للحجز." });
        timeField.current?.focus();
        return;
      }
      if (rebookReason.trim().length < 3 || rebookReason.trim().length > 500) {
        setScheduleError({ field: "reason", text: "اكتب سبب إعادة الحجز من 3 أحرف على الأقل، بحد أقصى 500 حرف." });
        reasonField.current?.focus();
        return;
      }
      rebookAttempt.current = {
        plannedVisitId: visit.id,
        uncertain: false,
        body: JSON.stringify({
          expectedAppointmentId: visit.appointmentId,
          expectedGeneration: visit.rebookGeneration,
          date: scheduleDate,
          time: scheduleTime,
          reason: rebookReason.trim(),
          requestId: crypto.randomUUID(),
        }),
      };
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: attempt.body,
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
        setRebookUncertain(false);
        setScheduleFor(null);
        setMessage("تمت إعادة حجز الجلسة. بقي الموعد السابق وحالته محفوظين في السجل.");
        onChanged();
        return;
      }
      if (!response.ok && response.status < 500 && !attempt.uncertain) {
        rebookAttempt.current = null;
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
      onVisitStarted?.();
    } catch {
      setMessage("تعذّر الاتصال بالخادم.");
    } finally {
      scheduleInFlight.current = false;
      setScheduleBusy(false);
    }
  };

  return (
    <>
      {message ? (
        <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-800">
          {message}
        </p>
      ) : null}

      {summary.plannedVisits.length > 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="الجلسات المخطَّطة">
          <h3 className="mb-2 text-xs font-extrabold text-navy-900">الجلسات المخطَّطة ({summary.plannedVisits.length})</h3>
          <ul className="space-y-2">
            {summary.plannedVisits.map((visit) => {
              const terminalAppointment = visit.appointmentStatus === "no_show" || visit.appointmentStatus === "cancelled";
              const isRebooking = terminalAppointment || rebookAttempt.current?.plannedVisitId === visit.id;
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
                        {visit.appointmentDate
                          ? ` · ${terminalAppointment ? "الموعد السابق" : "محجوزة"} ${friendlyDate(visit.appointmentDate)} ${visit.appointmentTime}`
                          : ""}
                      </p>
                      {terminalAppointment ? (
                        <p id={historyId} className="mt-1 text-xs font-bold text-amber-900">
                          {visit.appointmentStatus === "no_show" ? "لم يحضر الموعد السابق." : "أُلغي الموعد السابق."} يبقى الموعد السابق وحالته محفوظين؛ إعادة الحجز تنشئ موعدًا جديدًا ولا تبدأ زيارة.
                        </p>
                      ) : null}
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
                        <button
                          type="button"
                          onClick={() => openSchedule(visit.id)}
                          disabled={scheduleBusy || rebookUncertain}
                          aria-describedby={historyId}
                          className="cursor-pointer rounded-xl border border-navy-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800 hover:bg-navy-50 active:bg-navy-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          إعادة حجز
                        </button>
                      ) : null}
                      {!terminalAppointment && onVisitStarted ? (
                        <button
                          type="button"
                          onClick={() => void startPlannedVisit(visit.id)}
                          disabled={scheduleBusy || rebookUncertain}
                          className="cursor-pointer rounded-xl bg-brand-orange px-3 py-1.5 text-xs font-bold text-white hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          ابدأ الزيارة
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {scheduleFor === visit.id ? (
                    <form
                      noValidate
                      aria-label={isRebooking ? `إعادة حجز ${visit.title}` : `حجز ${visit.title}`}
                      aria-busy={scheduleBusy}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (isRebooking) void rebook(visit);
                        else void schedule(visit.id);
                      }}
                      className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-2.5"
                    >
                      <label className="text-[11px] font-bold text-slate-600">
                        التاريخ
                        <input
                          ref={dateField}
                          type="date"
                          value={scheduleDate}
                          min={clinicToday()}
                          required
                          disabled={scheduleBusy || rebookUncertain}
                          aria-invalid={scheduleError?.field === "date"}
                          aria-describedby={scheduleError ? errorId : undefined}
                          onChange={(event) => {
                            if (!scheduleInFlight.current && !rebookAttempt.current?.uncertain) setScheduleDate(event.target.value);
                          }}
                          className="mt-1 block w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-xs disabled:bg-slate-100"
                        />
                      </label>
                      <label className="text-[11px] font-bold text-slate-600">
                        الوقت
                        <input
                          ref={timeField}
                          type="time"
                          value={scheduleTime}
                          required
                          disabled={scheduleBusy || rebookUncertain}
                          aria-invalid={scheduleError?.field === "time"}
                          aria-describedby={scheduleError ? errorId : undefined}
                          onChange={(event) => {
                            if (!scheduleInFlight.current && !rebookAttempt.current?.uncertain) setScheduleTime(event.target.value);
                          }}
                          className="mt-1 block w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-xs disabled:bg-slate-100"
                        />
                      </label>
                      {isRebooking ? (
                        <label className="w-full text-[11px] font-bold text-slate-600">
                          سبب إعادة الحجز
                          <textarea
                            ref={reasonField}
                            value={rebookReason}
                            required
                            minLength={3}
                            maxLength={500}
                            rows={3}
                            disabled={scheduleBusy || rebookUncertain}
                            aria-invalid={scheduleError?.field === "reason"}
                            aria-describedby={scheduleError ? errorId : undefined}
                            onChange={(event) => {
                              if (!scheduleInFlight.current && !rebookAttempt.current?.uncertain) setRebookReason(event.target.value);
                            }}
                            className="mt-1 block w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 text-xs disabled:bg-slate-100"
                          />
                          <span className="font-normal">مطلوب، من 3 إلى 500 حرف. لا تغيّر إعادة الحجز السجل السابق أو الحساب المالي.</span>
                        </label>
                      ) : null}
                      {scheduleError ? (
                        <p id={errorId} role="alert" className="w-full text-xs font-bold text-amber-900">
                          {scheduleError.text}
                        </p>
                      ) : null}
                      <button
                        type="submit"
                        disabled={scheduleBusy || (isRebooking && !rebookUncertain && !visit.canRebook)}
                        className="min-w-32 cursor-pointer rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white hover:bg-navy-700 active:bg-navy-900 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {scheduleBusy ? "جارٍ الحجز…" : rebookUncertain ? "إعادة الطلب نفسه" : isRebooking ? "تأكيد إعادة الحجز" : "احجز"}
                      </button>
                      {rebookUncertain ? (
                        <button
                          type="button"
                          disabled={scheduleBusy}
                          onClick={() => window.location.reload()}
                          className="cursor-pointer rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          تحديث الملف للتحقق
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={scheduleBusy || rebookUncertain}
                        onClick={() => {
                          if (!scheduleInFlight.current && !rebookAttempt.current) {
                            setScheduleFor(null);
                            setScheduleError(null);
                          }
                        }}
                        className="cursor-pointer rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50 active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        إلغاء
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
