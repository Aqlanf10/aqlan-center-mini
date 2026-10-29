"use client";

import { useEffect, useId, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { DoctorDailyScheduleCard } from "@/components/DoctorDailyScheduleCard";
import { STATUS_LABEL } from "@/lib/appointment-lifecycle";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { addDays, clinicDateString, type Appointment } from "@/lib/schedule";
import type { LabReadinessItem } from "@/lib/lab-readiness";

/**
 * مواعيد اليوم لجلسة الهوية الموحّدة (M2 slices 15–16).
 *
 * GET /api/appointments?date= يعيد مواعيد اليوم ضمن نطاق مواعيدك (`all` كلها، و`own` المسندة
 * إليك)، وجاهزية أعمال المختبر لمن يملك الملخص التشغيلي. والحجز (POST /api/appointments) يظهر
 * لمن يملك appointments.create ويمرّ بمحرّك السعة نفسه؛ التعديل والإلغاء في شرائحهما. لا يُستدعى
 * هنا أي مسارٍ قديم.
 */
interface DayView {
  appointments: (Appointment & { labReadiness?: LabReadinessItem[] })[];
  projection: { labReadiness: boolean };
}

export function CanonicalAppointmentsDay() {
  const session = useSession();
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const [date, setDate] = useState(today);
  const [view, setView] = useState<DayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/appointments?date=${encodeURIComponent(date)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) { setView(null); setError(payload?.message ?? "تعذّر تحميل مواعيد اليوم."); return; }
        setView(payload as DayView);
        setError(null);
      } catch { if (!cancelled) setError("تعذّر الاتصال بالخادم."); }
    })();
    return () => { cancelled = true; };
  }, [date, version]);

  // جدولي الشخصي لمن نطاقه «مرضاي/مواعيدي»: يتطلب ربطًا سريريًا معتمدًا.
  const clinician = session?.appointmentScope === "own" || session?.patientScope === "own";
  const capabilities = new Set(session?.capabilities ?? []);
  const canBook = session?.isOwner === true || capabilities.has("appointments.create");
  const canOverride = session?.isOwner === true || capabilities.has("appointments.override-capacity");
  const appointments = view?.appointments ?? [];
  const active = appointments.filter(appointment => appointment.status !== "cancelled");
  return (
    <section aria-labelledby="appointments-day-title" className="mx-auto max-w-4xl space-y-4" data-testid="canonical-appointments-day">
      {clinician ? <DoctorDailyScheduleCard /> : null}
      <header className="flex flex-wrap items-end justify-between gap-2">
        <h1 id="appointments-day-title" className="text-lg font-black text-navy-900">مواعيد اليوم</h1>
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" onClick={() => setDate(addDays(date, -1))} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">اليوم السابق</button>
          <label className="text-xs font-bold text-navy-900">التاريخ
            <input type="date" aria-label="تاريخ المواعيد" value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }}
              className="mr-2 min-h-11 rounded-xl border border-slate-300 px-2 text-sm" />
          </label>
          <button type="button" onClick={() => setDate(addDays(date, 1))} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">اليوم التالي</button>
          <button type="button" onClick={() => setVersion(current => current + 1)} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">تحديث</button>
        </div>
      </header>
      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {canBook ? <BookingForm date={date} canOverride={canOverride} onBooked={() => setVersion(current => current + 1)} /> : null}
      {view ? (
        <>
          <p className="text-xs font-bold text-slate-700">{date === today ? "اليوم" : date} · غير ملغاة: {active.length} · الإجمالي: {appointments.length}</p>
          {appointments.length === 0 ? <p className="text-sm text-slate-600">لا مواعيد في هذا التاريخ ضمن نطاقك.</p> : (
            <ul className="space-y-2" data-testid="appointments-day-list">
              {appointments.map(appointment => (
                <li key={appointment.id} className="rounded-2xl border border-slate-200 bg-white p-3 text-sm" data-appointment={appointment.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span><span dir="ltr" className="ml-2 text-xs text-slate-600">{appointment.scheduledTime}</span><span className="font-bold text-navy-900">{appointment.patientName}</span></span>
                    <span className="text-xs text-slate-700">
                      {appointment.durationMinutes} دقيقة · {STATUS_LABEL[appointment.status] ?? appointment.status}{appointment.doctorName ? ` · ${appointment.doctorName}` : ""}
                    </span>
                  </div>
                  {appointment.appointmentType ? <p className="mt-1 text-xs text-slate-700">{appointment.appointmentType}</p> : null}
                  {appointment.labReadiness?.length ? (
                    <ul className="mt-1 flex flex-wrap gap-1" aria-label="جاهزية أعمال المختبر">
                      {appointment.labReadiness.map(item => (
                        <li key={item.orderId} className={`rounded-lg border px-2 py-0.5 text-[11px] font-bold ${item.level === "ready" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{item.workType}: {item.message}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : error ? null : <p role="status" className="text-sm text-slate-600">جارٍ تحميل المواعيد…</p>}
      <p className="text-xs text-slate-600">تعديل الموعد وإلغاؤه وحجز العودة تُنقل إلى الهوية الموحّدة تباعًا.</p>
    </section>
  );
}

interface PatientMatch { id: number; patientNumber: string; fullName: string }
interface Conflict { kind?: string; message: string; reasons: string[]; canOverride: boolean; overrideHint: string; suggestionMessage?: string; confirmationToken?: string }

/** حجزٌ عبر محرّك السعة: المريض من البحث (ضمن نطاقك)، والتعارض يُعرض بأسبابه واقتراحه. */
function BookingForm({ date, canOverride, onBooked }: { date: string; canOverride: boolean; onBooked: () => void }) {
  const uid = useId();
  const [term, setTerm] = useState("");
  const [matches, setMatches] = useState<PatientMatch[]>([]);
  const [patient, setPatient] = useState<PatientMatch | null>(null);
  const [time, setTime] = useState("09:00");
  const [duration, setDuration] = useState("30");
  const [note, setNote] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = term.trim();
    if (patient || query.length < 2) { setMatches([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/patients?q=${encodeURIComponent(query)}`, { cache: "no-store", signal: controller.signal })
        .then(response => response.ok ? response.json() : [])
        .then((rows: PatientMatch[]) => setMatches(Array.isArray(rows) ? rows.slice(0, 5) : []))
        .catch(() => undefined);
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [term, patient]);

  async function submit(confirmationToken?: string) {
    if (!patient) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/appointments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: patient.id, date, time, durationMinutes: Number(duration) || null, note: note || null,
          overrideReason: overrideReason || null, nearbyAppointmentConfirmation: confirmationToken ?? null,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409 && payload && Array.isArray(payload.reasons)) { setConflict(payload as Conflict); return; }
      if (!response.ok) { setMessage({ ok: false, text: payload?.message ?? "تعذّر حجز الموعد." }); return; }
      setConflict(null); setPatient(null); setTerm(""); setNote(""); setOverrideReason("");
      setMessage({ ok: true, text: payload?.warning ? `حُجز الموعد. ${payload.warning}` : `حُجز موعد ${payload?.patientName ?? ""} الساعة ${payload?.scheduledTime ?? time}.` });
      onBooked();
    } catch { setMessage({ ok: false, text: "تعذّر الاتصال بالخادم. لم يُعتبر الحجز تامًّا؛ حدّث القائمة." }); }
    finally { setBusy(false); }
  }

  const field = "mt-1 block min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm";
  return (
    <section aria-labelledby={`${uid}-title`} className="rounded-2xl border border-navy-200 bg-white p-4" data-testid="booking-form">
      <h2 id={`${uid}-title`} className="mb-2 text-sm font-bold text-navy-900">حجز موعد في {date}</h2>
      <div className="grid gap-2 sm:grid-cols-4">
        <label htmlFor={`${uid}-patient`} className="text-xs font-bold text-navy-900 sm:col-span-2">المريض
          <input id={`${uid}-patient`} value={patient ? `${patient.fullName} (${patient.patientNumber})` : term} disabled={busy}
            onChange={event => { setPatient(null); setTerm(event.target.value); }} className={field} />
        </label>
        <label htmlFor={`${uid}-time`} className="text-xs font-bold text-navy-900">الوقت
          <input id={`${uid}-time`} type="time" dir="ltr" value={time} disabled={busy} onChange={event => setTime(event.target.value)} className={field} />
        </label>
        <label htmlFor={`${uid}-duration`} className="text-xs font-bold text-navy-900">المدة بالدقائق
          <input id={`${uid}-duration`} inputMode="numeric" dir="ltr" value={duration} disabled={busy} onChange={event => setDuration(event.target.value)} className={field} />
        </label>
        <label htmlFor={`${uid}-note`} className="text-xs font-bold text-navy-900 sm:col-span-4">ملاحظة
          <input id={`${uid}-note`} value={note} disabled={busy} onChange={event => setNote(event.target.value)} className={field} />
        </label>
      </div>
      {matches.length > 0 ? (
        <ul aria-label="ملفات مطابقة" className="mt-2 space-y-1">
          {matches.map(match => (
            <li key={match.id}>
              <button type="button" onClick={() => { setPatient(match); setMatches([]); }}
                className="min-h-11 w-full rounded-xl border border-slate-200 px-3 text-start text-sm hover:border-navy-300">
                {match.fullName} <span className="text-xs text-slate-600">({match.patientNumber})</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {conflict ? (
        <div role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="booking-conflict">
          <p className="font-bold">{conflict.message}</p>
          {conflict.reasons.length ? <ul className="mt-1 list-inside list-disc text-xs">{conflict.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
          {conflict.suggestionMessage ? <p className="mt-1 text-xs">{conflict.suggestionMessage}</p> : null}
          {conflict.kind === "nearby_patient_appointments" && conflict.confirmationToken ? (
            <button type="button" disabled={busy} onClick={() => void submit(conflict.confirmationToken)} className="mt-2 min-h-11 rounded-xl border border-amber-400 bg-white px-3 text-xs font-bold">تأكيد الحجز رغم ذلك</button>
          ) : null}
          {conflict.canOverride && canOverride ? (
            <label htmlFor={`${uid}-override`} className="mt-2 block text-xs font-bold">سبب تجاوز السعة (يُسجَّل في التدقيق)
              <input id={`${uid}-override`} value={overrideReason} disabled={busy} onChange={event => setOverrideReason(event.target.value)} className={field} />
            </label>
          ) : <p className="mt-1 text-xs">{conflict.overrideHint}</p>}
        </div>
      ) : null}
      <button type="button" disabled={busy || !patient} onClick={() => void submit()}
        className="mt-3 min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">احجز</button>
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p> : null}
    </section>
  );
}
