"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { DoctorDailyScheduleCard } from "@/components/DoctorDailyScheduleCard";
import { STATUS_LABEL } from "@/lib/appointment-lifecycle";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { addDays, clinicDateString, type Appointment } from "@/lib/schedule";
import type { LabReadinessItem } from "@/lib/lab-readiness";

/**
 * مواعيد اليوم لجلسة الهوية الموحّدة (M2 slice 15) — قراءةٌ فقط.
 *
 * GET /api/appointments?date= يعيد مواعيد اليوم ضمن نطاق مواعيدك (`all` كلها، و`own` المسندة
 * إليك)، وجاهزية أعمال المختبر لمن يملك الملخص التشغيلي. الحجز والتعديل والإلغاء تُنقل في
 * شرائحها؛ لا يُستدعى هنا أي مسارٍ قديم.
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
      <p className="text-xs text-slate-600">الحجز والتعديل والإلغاء من هذه الشاشة تُنقل إلى الهوية الموحّدة تباعًا.</p>
    </section>
  );
}
