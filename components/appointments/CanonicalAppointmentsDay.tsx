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
 * لمن يملك appointments.create ويمرّ بمحرّك السعة نفسه. وإجراءات الموعد المحجوز (PATCH
 * /api/appointments/[id], slice 17) تحت appointments.edit: «وصل» بـvisits.manage، والإلغاء وعدم
 * الحضور بـappointments.cancel، والنقل (slice 18) عبر محرّك السعة نفسه بسببٍ إلزامي. لا يُستدعى هنا
 * أي مسارٍ قديم.
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
  const [freed, setFreed] = useState<Freed | null>(null);
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
  const owner = session?.isOwner === true;
  const canEdit = owner || capabilities.has("appointments.edit");
  const moves = { arrive: canEdit && (owner || capabilities.has("visits.manage")), close: canEdit && (owner || capabilities.has("appointments.cancel")), reschedule: canEdit, override: canEdit && canOverride };
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
      {freed ? <FreedSlotNotice freed={freed} canBook={canBook && canEdit} onBooked={() => { setFreed(null); setVersion(current => current + 1); }} /> : null}
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
                  {appointment.status === "booked" && (moves.arrive || moves.close || moves.reschedule)
                    ? <AppointmentActions appointment={appointment} moves={moves} onMoved={waiting => { setFreed(waiting); setVersion(current => current + 1); }} />
                    : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : error ? null : <p role="status" className="text-sm text-slate-600">جارٍ تحميل المواعيد…</p>}
      <p className="text-xs text-slate-600">حجز العودة من سياق الحالة يُنقل إلى الهوية الموحّدة تباعًا.</p>
    </section>
  );
}

/** إجراءات موعدٍ محجوز: كل ردٍّ مرفوض يُعرض نصُّه، ولا يُعتبر الإجراء تامًّا قبل ردٍّ ناجح. */
/** Who fits the freed slot: names and reasons from the canonical waiting-list match
 * (GET /api/waiting-list?date=&time=), inside the actor's scope, only on request. */
function FreedSlotNotice({ freed, canBook, onBooked }: { freed: Freed; canBook: boolean; onBooked: () => void }) {
  const [candidates, setCandidates] = useState<{ id: number; patientName: string; matchReason: string }[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* «احجز له» بعد أن يوافق المريض: الحجز عبر محرّك السعة نفسه، ويُغلق صفّه في المعاملة نفسها. */
  async function bookFor(id: number) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/waiting-list/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "book", date: freed.slot.date, time: freed.slot.time }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const reasons: string[] = Array.isArray(payload?.conflict?.reasons) ? payload.conflict.reasons : [];
        setMessage([payload?.message ?? "تعذّر الحجز.", ...reasons].join(" — "));
        return;
      }
      onBooked();
    } catch { setMessage("تعذّر الاتصال بالخادم. لم يُعتبر الحجز تامًّا؛ حدّث القائمة."); }
    finally { setBusy(false); }
  }
  async function show() {
    setMessage(null);
    try {
      const response = await fetch(`/api/waiting-list?date=${encodeURIComponent(freed.slot.date)}&time=${encodeURIComponent(freed.slot.time)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر تحميل المرشّحين."); return; }
      setCandidates(Array.isArray(payload?.candidates) ? payload.candidates : []);
    } catch { setMessage("تعذّر الاتصال بالخادم."); }
  }
  return (
    <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="freed-slot">
      <p>شغر مكان {freed.slot.date} الساعة <span dir="ltr">{freed.slot.time}</span> — في قائمة الانتظار {freed.count} يصلحون له.</p>
      <div className="mt-2 flex max-w-full flex-wrap gap-2">
        <button type="button" onClick={() => void show()} className="min-h-11 rounded-xl border border-emerald-300 bg-white px-3 text-xs font-bold">اعرض المرشّحين</button>
        <a href="/waiting-list" className="inline-flex min-h-11 items-center text-xs font-bold underline">افتح قائمة الانتظار</a>
      </div>
      {candidates ? (
        <ul className="mt-2 space-y-1 text-xs" aria-label="المرشّحون للمكان الشاغر">
          {candidates.length === 0 ? <li>لم يعد أحدٌ يصلح لهذا المكان.</li> : candidates.map(candidate => (
            <li key={candidate.id} className="flex flex-wrap items-center gap-2">
              <span><span className="font-bold">{candidate.patientName}</span> — {candidate.matchReason}</span>
              {canBook ? <button type="button" disabled={busy} onClick={() => void bookFor(candidate.id)} className="min-h-11 rounded-xl border border-emerald-400 bg-white px-3 text-xs font-bold disabled:opacity-50">احجز له</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <p role="alert" className="mt-1 text-xs text-red-700">{message}</p> : null}
    </div>
  );
}

type Moves = { arrive: boolean; close: boolean; reschedule: boolean; override: boolean };
/** The freed slot after a cancel or no-show: how many waiting entries in your scope fit. */
interface Freed { count: number; slot: { date: string; time: string } }

function AppointmentActions({ appointment, moves, onMoved }: { appointment: Appointment; moves: Moves; onMoved: (waiting: Freed | null) => void }) {
  const uid = useId();
  const [cancelling, setCancelling] = useState(false);
  const [moving, setMoving] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function remove() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/appointments/${appointment.id}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.trim() || null }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر حذف الموعد."); return; }
      setCancelling(false); setReason("");
      onMoved(null);
    } catch { setMessage("تعذّر الاتصال بالخادم. حدّث القائمة قبل إعادة المحاولة."); }
    finally { setBusy(false); }
  }
  async function move(action: "arrive" | "cancel" | "no_show") {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/appointments/${appointment.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "cancel" ? { action, reason: reason.trim() || null } : { action }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر تنفيذ الإجراء."); return; }
      setCancelling(false); setReason("");
      onMoved(payload?.waiting && typeof payload.waiting.count === "number" ? payload.waiting as Freed : null);
    } catch { setMessage("تعذّر الاتصال بالخادم. حدّث القائمة قبل إعادة المحاولة."); }
    finally { setBusy(false); }
  }
  const button = "min-h-11 rounded-xl border px-3 text-xs font-bold disabled:opacity-50";
  return (
    <div className="mt-2 space-y-2">
      <div className="flex max-w-full flex-wrap gap-2">
        {moves.arrive ? <button type="button" disabled={busy} onClick={() => void move("arrive")} className={`${button} border-emerald-300 text-emerald-800`}>وصل</button> : null}
        {moves.close ? <button type="button" disabled={busy} onClick={() => void move("no_show")} className={`${button} border-slate-300 text-navy-800`}>لم يحضر</button> : null}
        {moves.close ? <button type="button" disabled={busy} aria-expanded={cancelling} onClick={() => { setCancelling(current => !current); setMoving(false); }} className={`${button} border-red-200 text-red-800`}>إلغاء الموعد</button> : null}
        {moves.reschedule ? <button type="button" disabled={busy} aria-expanded={moving} onClick={() => { setMoving(current => !current); setCancelling(false); }} className={`${button} border-navy-200 text-navy-800`}>نقل الموعد</button> : null}
      </div>
      {moving ? <RescheduleForm appointment={appointment} canOverride={moves.override} onMoved={() => { setMoving(false); onMoved(null); }} /> : null}
      {cancelling ? (
        <div className="flex max-w-full flex-wrap items-end gap-2">
          <label htmlFor={`${uid}-reason`} className="text-xs font-bold text-navy-900">سبب الإلغاء
            <input id={`${uid}-reason`} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} className="mt-1 block min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm" />
          </label>
          <button type="button" disabled={busy} onClick={() => void move("cancel")} className={`${button} border-red-300 bg-red-50 text-red-800`}>تأكيد الإلغاء</button>
          <button type="button" disabled={busy} onClick={() => void remove()} className={`${button} border-slate-300 text-slate-700`} title="لموعدٍ أُدخل خطأً: يُحذف ويبقى أثره في التدقيق">حذف نهائي (إدخال خاطئ)</button>
        </div>
      ) : null}
      {message ? <p role="alert" className="text-xs text-red-700">{message}</p> : null}
    </div>
  );
}

/** نقلٌ عبر محرّك السعة: السبب إلزامي، والتعارض يُعرض بأسبابه، والتجاوز بسببٍ لمن يملك منحته. */
function RescheduleForm({ appointment, canOverride, onMoved }: { appointment: Appointment; canOverride: boolean; onMoved: () => void }) {
  const uid = useId();
  const [date, setDate] = useState(appointment.scheduledDate);
  const [time, setTime] = useState(appointment.scheduledTime.slice(0, 5));
  const [reason, setReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(confirmationToken?: string) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/appointments/${appointment.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reschedule", date, time, reason: reason.trim(), overrideReason: overrideReason.trim() || null, nearbyAppointmentConfirmation: confirmationToken ?? null }),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409 && payload?.conflict && Array.isArray(payload.conflict.reasons)) { setConflict(payload.conflict as Conflict); return; }
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر نقل الموعد."); return; }
      onMoved();
    } catch { setMessage("تعذّر الاتصال بالخادم. لم يُعتبر النقل تامًّا؛ حدّث القائمة."); }
    finally { setBusy(false); }
  }
  const field = "mt-1 block min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm";
  return (
    <div className="max-w-full rounded-xl border border-navy-200 p-3" data-testid="reschedule-form">
      <div className="grid gap-2 sm:grid-cols-3">
        <label htmlFor={`${uid}-date`} className="text-xs font-bold text-navy-900">التاريخ الجديد
          <input id={`${uid}-date`} type="date" dir="ltr" value={date} disabled={busy} onChange={event => setDate(event.target.value)} className={field} />
        </label>
        <label htmlFor={`${uid}-time`} className="text-xs font-bold text-navy-900">الوقت الجديد
          <input id={`${uid}-time`} type="time" dir="ltr" value={time} disabled={busy} onChange={event => setTime(event.target.value)} className={field} />
        </label>
        <label htmlFor={`${uid}-reason`} className="text-xs font-bold text-navy-900">سبب النقل
          <input id={`${uid}-reason`} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} className={field} />
        </label>
      </div>
      {conflict ? (
        <div role="alert" className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="reschedule-conflict">
          <p className="font-bold">{conflict.message}</p>
          {conflict.reasons.length ? <ul className="mt-1 list-inside list-disc text-xs">{conflict.reasons.map(item => <li key={item}>{item}</li>)}</ul> : null}
          {conflict.suggestionMessage ? <p className="mt-1 text-xs">{conflict.suggestionMessage}</p> : null}
          {conflict.kind === "nearby_patient_appointments" && conflict.confirmationToken ? (
            <button type="button" disabled={busy} onClick={() => void submit(conflict.confirmationToken)} className="mt-2 min-h-11 rounded-xl border border-amber-400 bg-white px-3 text-xs font-bold">تأكيد النقل رغم ذلك</button>
          ) : null}
          {conflict.canOverride && canOverride ? (
            <label htmlFor={`${uid}-override`} className="mt-2 block text-xs font-bold">سبب تجاوز السعة (يُسجَّل في التدقيق)
              <input id={`${uid}-override`} value={overrideReason} disabled={busy} onChange={event => setOverrideReason(event.target.value)} className={field} />
            </label>
          ) : <p className="mt-1 text-xs">{conflict.overrideHint}</p>}
        </div>
      ) : null}
      <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void submit()} className="mt-2 min-h-11 rounded-xl bg-navy-900 px-4 text-xs font-bold text-white disabled:opacity-50">تأكيد النقل</button>
      {message ? <p role="alert" className="mt-1 text-xs text-red-700">{message}</p> : null}
    </div>
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
