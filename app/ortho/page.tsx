"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  friendlyDateLong, friendlyTime, reminderText, toWhatsAppNumber, unbookedFollowupText,
} from "@/lib/reminders";
import { clinicDateString, getAppointmentTypeLabel } from "@/lib/schedule";
import { sinceAdjustmentText } from "@/lib/ortho-followup";
import {
  BUCKET_LABEL, BUCKET_ORDER, BUCKET_TONE,
  type FollowupBucket, type FollowupRow,
} from "@/lib/ortho-followup";
import { PageHeader } from "@/components/PageHeader";
import { OrthoPendingDecisions } from "@/components/OrthoPendingDecisions";
import { QuickAppointmentModal } from "@/components/QuickAppointmentModal";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

/**
 * مركز متابعة التقويم — قائمة يومية للاستقبال.
 *
 * «لا يجوز أن يخرج المريض من الجلسة بينما النظام يعرف أنه يجب أن يعود بعد ٤
 * أسابيع لكن لا يوجد له موعد فعلي» — بكلمات المالك. هذه الشاشة هي الضمانة
 * الثانية: من لم تُغلق حلقتُه في ملف التقويم يظهر هنا، في قائمةٍ تُفتح كل
 * صباح قبل أن يفتح المريض فمه.
 */

interface BoardBucket {
  bucket: FollowupBucket;
  count: number;
  rows: FollowupRow[];
}

interface BoardFeed {
  today: string;
  buckets: BoardBucket[];
}

const TONE_CLASS: Record<string, string> = {
  red: "border-red-300 bg-red-50 text-red-800",
  amber: "border-amber-300 bg-amber-50 text-amber-800",
  navy: "border-navy-200 bg-navy-50 text-navy-900",
  slate: "border-slate-200 bg-slate-50 text-slate-600",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

export default function OrthoFollowupPage() {
  const fallbackToday = useMemo(() => clinicDateString(new Date(), CLINIC_ZONE_FALLBACK), []);
  const [feed, setFeed] = useState<BoardFeed | null>(null);
  const today = feed?.today ?? fallbackToday;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<FollowupBucket>("no_appointment");
  const [rebook, setRebook] = useState<{ id: number; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/ortho/followups", { cache: "no-store" });
      const payload = (await response.json()) as BoardFeed & { message?: string };
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFeed(payload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const buckets = feed?.buckets ?? [];
  const activeBucket = buckets.find((bucket) => bucket.bucket === active) ?? null;

  const bookingContextKnown = (row: FollowupRow) => row.bookingContext?.verified === true
    && Array.isArray(row.bookingContext.reviewAppointments) && Array.isArray(row.bookingContext.otherAppointments)
    && Object.hasOwn(row.bookingContext, "pastUnresolvedAppointment");
  const confirmedAppointment = (row: FollowupRow) => bookingContextKnown(row)
    && row.nextAppointment && row.nextAppointment.date >= today
    && (row.nextAppointment.status === "booked" || row.nextAppointment.status === "arrived")
    ? row.nextAppointment : null;

  /** الاستحقاق المحسوب ليس حجزًا: ندعو لترتيب متابعة حتى يوجد موعد فعلي. */
  const reminderMessage = (row: FollowupRow): string => {
    const appointment = confirmedAppointment(row);
    if (!appointment) return unbookedFollowupText(row.patientName);
    return reminderText({
      id: appointment.id,
      patientId: row.patientId,
      patientName: row.patientName,
      patientPhone: row.patientPhone,
      scheduledDate: appointment.date,
      scheduledTime: appointment.time,
      durationMinutes: 15,
      note: null,
      status: "booked",
    }, "upcoming");
  };

  /** رابط واتساب صحيح أو null — الرقم اليمني يُحوّل للصيغة الدولية المُتحقَّقة. */
  const reminderLink = (row: FollowupRow): string | null => {
    const number = toWhatsAppNumber(row.patientPhone);
    if (!number) return null;
    return `https://wa.me/${number}?text=${encodeURIComponent(reminderMessage(row))}`;
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="مركز متابعة التقويم"
        subtitle="قائمة اليوم: من يحتاج شدّة، ومن بلا موعد قادم، ومن تجاوز أو غاب — قبل أن يذوب."
      />

      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {/* (P1-C) شدّات خارج العقد بانتظار قرار فوترة. */}
      <OrthoPendingDecisions />

      {/* عدّاد القوائم — الأخطر أولًا، والفارغة تختارن إخفاءها لا تحمل الضجيج. */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {BUCKET_ORDER.map((bucket) => {
          const bucketData = buckets.find((row) => row.bucket === bucket);
          const count = bucketData?.count ?? 0;
          if (count === 0 && bucket !== active) return null;
          return (
            <button key={bucket} onClick={() => setActive(bucket)}
              className={`rounded-xl border px-3 py-1.5 text-xs font-extrabold ${
                active === bucket
                  ? "border-navy-800 bg-navy-800 text-white"
                  : TONE_CLASS[BUCKET_TONE[bucket]] ?? TONE_CLASS.slate
              }`}>
              {BUCKET_LABEL[bucket]}
              <span className={`mr-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${
                active === bucket ? "bg-white/20" : "bg-white/70"
              }`}>{count}</span>
            </button>
          );
        })}
      </div>

      {loading && !feed ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : !activeBucket || activeBucket.count === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا أحد في هذه القائمة اليوم — وتلك رسالةٌ طيّبة.
        </p>
      ) : (
        <ul className="space-y-2">
          {activeBucket.rows.map((row) => {
            const contextKnown = bookingContextKnown(row);
            const appointment = confirmedAppointment(row);
            const past = contextKnown ? row.bookingContext?.pastUnresolvedAppointment : null;
            const existing = contextKnown ? [
              ...(row.bookingContext?.reviewAppointments ?? []).map((item) => ({ ...item, review: true })),
              ...(row.bookingContext?.otherAppointments ?? []).map((item) => ({ ...item, review: false })),
            ].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id - b.id) : [];
            const reviewDay = existing.find((item) => item.date >= today) ?? past ?? existing[0];
            return (
            <li key={row.caseId} className="rounded-2xl border border-slate-200 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <a href={`/patients/${row.patientId}`}
                    className="text-sm font-extrabold text-navy-900 underline decoration-navy-200 underline-offset-4 hover:decoration-navy-800">
                    {row.patientName}
                  </a>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    آخر شدّ: {row.lastAdjustmentDate ? friendlyDateLong(row.lastAdjustmentDate) : "بلا شدّات"} ({sinceAdjustmentText(row.daysSinceLast)})
                    {" · الاستحقاق: "}{friendlyDateLong(row.dueDate)}
                  </p>
                  {!contextKnown ? (
                    <p role="status" className="mt-0.5 text-[11px] font-bold text-amber-700">
                      تعذّر التحقق من سياق المواعيد — راجع المواعيد قبل إضافة حجز
                    </p>
                  ) : appointment ? (
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      موعد متابعة التقويم المسجل: {friendlyDateLong(appointment.date)} الساعة {friendlyTime(appointment.time)}
                      {appointment.serviceName ? ` · ${appointment.serviceName}` : ""}
                      {appointment.doctorName ? ` · ${appointment.doctorName}` : ""}
                      {appointment.status === "arrived" ? " · وصل" : " · محجوز"}
                      {appointment.matchBasis === "legacy_type" ? " · مصنف حسب نوع الموعد القديم" : ""}
                      {appointment.matchBasis === "designated_service" ? " · حسب تصنيف الخدمة الحالي" : ""}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[11px] font-bold text-amber-700">لا موعد متابعة تقويم مؤكد</p>
                  )}
                  {past ? (
                    <p className="mt-1 text-[11px] font-bold text-amber-800">
                      موعد متابعة سابق لم يُغلق: {friendlyDateLong(past.date)} الساعة {friendlyTime(past.time)}
                      {past.serviceName ? ` · ${past.serviceName}` : ""}
                      {past.doctorName ? ` · ${past.doctorName}` : ""}
                      {past.status === "arrived" ? " · وصل" : " · محجوز"}
                      {past.matchBasis === "legacy_type" ? " · مصنف حسب نوع الموعد القديم" : ""}
                      {past.matchBasis === "designated_service" ? " · حسب تصنيف الخدمة الحالي" : ""}
                    </p>
                  ) : null}
                  {existing.length ? (
                    <div className="mt-2 min-w-0 space-y-1 break-words rounded-xl border border-amber-200 bg-amber-50 p-2">
                      <p className="text-[11px] font-bold text-amber-900">مواعيد قائمة للمريض — راجعها قبل إضافة حجز</p>
                      {existing.map((item) => (
                        <div key={item.id} className="text-[11px] text-slate-700">
                          <p>
                            {item.review ? "يحتاج مراجعة سياق المتابعة" : "موعد آخر"}
                            {" · "}{friendlyDateLong(item.date)} الساعة {friendlyTime(item.time)}
                            {" · "}{item.serviceName ?? getAppointmentTypeLabel(item.appointmentType) ?? "خدمة غير محددة"}
                            {item.doctorName ? ` · ${item.doctorName}` : " · الطبيب غير محدد"}
                            {item.status === "arrived" ? " · وصل" : item.status === "booked" ? " · محجوز" : " · حالة الموعد بحاجة مراجعة"}
                          </p>
                          <a href={`/appointments?date=${encodeURIComponent(item.date)}`} className="inline-flex min-h-11 items-center px-2 font-bold text-navy-800 underline">
                            فتح يوم المواعيد
                          </a>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <p className="mt-0.5 text-[10px] text-slate-400" dir="ltr">
                    {row.upperWire || row.lowerWire ? `U: ${row.upperWire ?? "—"} · L: ${row.lowerWire ?? "—"}` : ""}
                  </p>
                </div>
                <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
                  {reviewDay ? (
                    <a href={`/appointments?date=${encodeURIComponent(reviewDay.date)}`}
                      className="inline-flex min-h-11 items-center rounded-xl bg-navy-800 px-3 py-2 text-xs font-extrabold text-white">
                      راجع يوم المواعيد أولًا
                    </a>
                  ) : !contextKnown ? (
                    <a href={`/patients/${row.patientId}`} className="inline-flex min-h-11 items-center rounded-xl border border-amber-300 px-3 py-2 text-xs font-bold text-amber-800">
                      افتح ملف المريض للمراجعة
                    </a>
                  ) : null}
                  {contextKnown ? (
                    <button onClick={() => setRebook({ id: row.patientId, name: row.patientName })}
                      className={reviewDay
                        ? "inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600"
                        : "inline-flex min-h-11 items-center rounded-xl bg-navy-800 px-3 py-2 text-xs font-extrabold text-white"}>
                      {reviewDay ? "📅 احجز بعد المراجعة" : "📅 احجز"}
                    </button>
                  ) : null}
                  {reminderLink(row) ? (
                    <a
                      href={reminderLink(row) ?? "#"}
                      target="_blank" rel="noopener"
                      className="inline-flex min-h-11 items-center justify-center rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-extrabold text-emerald-700">
                      {appointment ? "واتساب تذكير" : "واتساب لترتيب متابعة"}
                    </a>
                  ) : null}
                  <a href={`/patients/${row.patientId}?tab=treatment`}
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600">
                    ملف التقويم
                  </a>
                </div>
              </div>
            </li>
            );
          })}
        </ul>
      )}

      {rebook ? (
        <QuickAppointmentModal
          patientId={rebook.id}
          patientName={rebook.name}
          isOpen
          onClose={() => setRebook(null)}
          onSuccess={() => { setRebook(null); void load(); }}
        />
      ) : null}
    </div>
  );
}
