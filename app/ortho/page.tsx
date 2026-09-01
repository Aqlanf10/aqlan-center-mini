"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  friendlyDateLong, friendlyTime, reminderText, toWhatsAppNumber,
} from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { sinceAdjustmentText } from "@/lib/ortho-followup";
import {
  BUCKET_LABEL, BUCKET_ORDER, BUCKET_TONE,
  type FollowupBucket, type FollowupRow,
} from "@/lib/ortho-followup";
import { PageHeader } from "@/components/PageHeader";
import { QuickAppointmentModal } from "@/components/QuickAppointmentModal";

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
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);
  const [feed, setFeed] = useState<BoardFeed | null>(null);
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

  /** رسالة التذكير بقائمة اليوم — تُبنى من بيانات الصف لا من موعدٍ موجود. */
  const reminderMessage = (row: FollowupRow): string =>
    reminderText({
      id: row.nextAppointment?.id ?? row.caseId,
      patientId: row.patientId,
      patientName: row.patientName,
      patientPhone: row.patientPhone,
      scheduledDate: row.nextAppointment?.date ?? row.dueDate,
      scheduledTime: row.nextAppointment?.time ?? "16:00",
      durationMinutes: 15,
      note: null,
      status: "booked",
    }, "upcoming");

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
          {activeBucket.rows.map((row) => (
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
                  {row.nextAppointment ? (
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      الموعد المحجوز: {friendlyDateLong(row.nextAppointment.date)} الساعة {friendlyTime(row.nextAppointment.time)}
                      {row.nextAppointment.date < today ? " — تجاوزه ولم يُنفَّذ" : ""}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[11px] font-bold text-amber-700">لا موعد قادم محجوز</p>
                  )}
                  <p className="mt-0.5 text-[10px] text-slate-400" dir="ltr">
                    {row.upperWire || row.lowerWire ? `U: ${row.upperWire ?? "—"} · L: ${row.lowerWire ?? "—"}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <button onClick={() => setRebook({ id: row.patientId, name: row.patientName })}
                    className="rounded-xl bg-navy-800 px-3 py-2 text-xs font-extrabold text-white">
                    📅 احجز
                  </button>
                  {reminderLink(row) ? (
                    <a
                      href={reminderLink(row) ?? "#"}
                      target="_blank" rel="noopener"
                      className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-extrabold text-emerald-700">
                      واتساب تذكير
                    </a>
                  ) : null}
                  <a href={`/patients/${row.patientId}?tab=treatment`}
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600">
                    ملف التقويم
                  </a>
                </div>
              </div>
            </li>
          ))}
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
