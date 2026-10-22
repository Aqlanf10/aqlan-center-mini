"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { clinicDateString } from "@/lib/schedule";
import { isDoctorDailySchedule } from "@/lib/doctor-daily-schedule-payload";
import type { DoctorDailySchedule } from "@/lib/doctor-daily-schedule";

const STATUS: Record<string, string> = {
  booked: "محجوز", arrived: "وصل", done: "تمّ", no_show: "لم يحضر", cancelled: "أُلغي",
};

export function DoctorDailyScheduleCard() {
  const session = useSession();
  const owner = useMemo(() => Symbol(session?.username ?? "signed-out"), [session]);
  const actor = session ? `${session.username}:${session.role}` : "";
  const [selection, setSelection] = useState({ date: "today", revision: 0 });
  const [result, setResult] = useState<{ owner: symbol; key: string; data?: DoctorDailySchedule; error?: string } | null>(null);
  const key = `${actor}:${selection.date}:${selection.revision}`;
  useEffect(() => {
    if (!actor) return;
    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        const response = await fetch(`/api/appointments/mine?date=${encodeURIComponent(selection.date)}`, {
          cache: "no-store", signal: controller.signal,
        });
        const payload = await response.json();
        if (!current) return;
        if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل المواعيد.");
        if (!isDoctorDailySchedule(payload, selection.date)) throw new Error("تعذّر التحقق من تاريخ الجدول. حدّث الصفحة.");
        setResult({ owner, key, data: payload });
      } catch (error) {
        if (current) setResult({ owner, key, error: error instanceof Error ? error.message : "تعذّر الاتصال بالخادم." });
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [key, selection.date, actor, owner]);
  // Render-time fence: changing heading hides previous data before the next effect runs.
  const visible = result?.key === key && result.owner === owner ? result : null;
  const data = visible?.data;
  const choose = (date: string) => setSelection((previous) => ({ date, revision: previous.revision + 1 }));
  useEffect(() => {
    if (!actor || typeof window === "undefined") return;
    const refresh = () => setSelection((previous) => ({ ...previous, revision: previous.revision + 1 }));
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = window.setInterval(() => {
      if (data && (selection.date === "today" || selection.date === "tomorrow")
        && clinicDateString(new Date(), data.timeZone) !== data.today) refresh();
    }, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [actor, data, selection.date]);
  if (!actor) return null;
  const buttonClass = "min-h-11 rounded-lg border border-slate-300 px-3 text-xs font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-navy-700";
  return (
    <section aria-label="جدول مواعيدي" className="mb-5 rounded-xl border border-slate-200 bg-white p-3">
      <h2 className="text-sm font-extrabold text-navy-900">جدول مواعيدي</h2>
      <p className="mt-1 text-xs text-slate-500">المواعيد المسندة إليك فقط، بما فيها الملغاة. جدول مباشر وليس تقرير إقفال يومي.</p>
      <div className="my-3 flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} aria-pressed={selection.date === "today"} onClick={() => choose("today")}>اليوم</button>
        <button type="button" className={buttonClass} aria-pressed={selection.date === "tomorrow"} onClick={() => choose("tomorrow")}>غدًا</button>
        <label className="text-xs font-bold">تاريخ محدد
          <input type="date" aria-label="تاريخ جدول المواعيد" className={`${buttonClass} mr-2`} value={/^\d{4}-/.test(selection.date) ? selection.date : data?.date ?? ""} onChange={(event) => { if (event.target.value) choose(event.target.value); }} />
        </label>
        <button type="button" className={buttonClass} onClick={() => choose(selection.date)}>تحديث</button>
      </div>
      {!visible ? <p role="status" className="text-xs text-slate-500">جارٍ تحميل الجدول…</p> : null}
      {visible?.error ? <p role="alert" className="text-xs font-bold text-red-700">{visible.error}</p> : null}
      {data ? <>
        <p className="mb-2 text-xs text-slate-600">{data.date} · توقيت العيادة: {data.timeZone} · آخر تحديث: <time dateTime={data.generatedAt}>{new Date(data.generatedAt).toLocaleTimeString("ar", { timeZone: data.timeZone, hour: "2-digit", minute: "2-digit" })}</time></p>
        <p className="mb-3 text-xs font-bold">غير ملغاة: {data.counts.scheduled} · ملغاة: {data.counts.cancelled} · الإجمالي: {data.counts.total}</p>
        {data.appointments.length === 0 ? <p className="text-xs text-slate-500">لا مواعيد مسندة إليك في هذا التاريخ.</p> : <ul className="space-y-2">
          {data.appointments.map((row) => <li key={row.appointmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
            <div><span dir="ltr" className="ml-2 text-xs text-slate-500">{row.time}</span>
              {row.patientHref ? <a className="text-sm font-bold text-navy-900 hover:underline" href={row.patientHref}>{row.patientName}</a> : <span className="text-sm font-bold">{row.patientName}</span>}
            </div>
            <span className="text-xs text-slate-600">{row.durationMinutes} دقيقة · {STATUS[row.status] ?? row.status}{row.hasReferral ? " · إحالة مرتبطة" : ""}</span>
          </li>)}
        </ul>}
      </> : null}
    </section>
  );
}
