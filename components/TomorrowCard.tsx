"use client";

import { useEffect, useState } from "react";
import { awaitsReminder } from "@/lib/reminders";
import { hasPendingLabWork } from "@/lib/lab-readiness";
import { clinicDateString, type Appointment } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

/** بعد كم دقيقة تُعاد قراءة الغد — لا يتغيّر كل عشرين ثانية كطابور اليوم. */
const REFRESH_MS = 5 * 60_000;

export function tomorrowOf(today: string): string {
  const [year, month, day] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export interface TomorrowSummary {
  booked: number;
  unreminded: number;
  labPending: number;
}

/** أرقام الغد من قائمته — المحجوز، ومن لم يُذكَّر، ومن ينتظر تركيبته. */
export function summarizeTomorrow(appointments: readonly Appointment[]): TomorrowSummary {
  const booked = appointments.filter((item) => item.status === "booked");
  return {
    booked: booked.length,
    unreminded: booked.filter(awaitsReminder).length,
    labPending: booked.filter((item) => hasPendingLabWork(item.labReadiness)).length,
  };
}

/**
 * بطاقة «الغد» على الشاشة الرئيسية — جولة المساء بضغطة.
 *
 * تقول ما بقي على الاستقبال قبل أن يُغلق اليوم: كم مريضًا لم يُذكَّر بموعده، وكم
 * موعدًا ينتظر تركيبةً لم تصل — وكلٌّ رابطٌ يفتح قائمة الغد بفلترها جاهزًا. لا تظهر
 * إن لم يكن في الغد عملٌ باقٍ.
 */
export function TomorrowCard() {
  const [summary, setSummary] = useState<TomorrowSummary | null>(null);
  const [tomorrow, setTomorrow] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const day = tomorrowOf(clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
      try {
        const response = await fetch(`/api/appointments?date=${day}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok || !Array.isArray(payload)) {
          setTomorrow("");
          setSummary(null);
          return;
        }
        setTomorrow(day);
        setSummary(summarizeTomorrow(payload as Appointment[]));
      } catch {
        /* بطاقةٌ مساعدة: تعذّر تحميلها لا يعطّل الشاشة، ولا نُبقي أرقامًا قديمة. */
        if (!cancelled) {
          setTomorrow("");
          setSummary(null);
        }
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (!summary || summary.booked === 0 || (summary.unreminded === 0 && summary.labPending === 0)) return null;

  return (
    <section data-tomorrow-card aria-label="الغد" className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <h2 className="text-sm font-bold text-amber-950">غدًا: {summary.booked} موعدًا محجوزًا</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {summary.unreminded > 0 ? (
          <a href={`/appointments?date=${tomorrow}&filter=unreminded`}
            className="rounded-xl bg-[#25D366] px-3 py-1.5 text-xs font-extrabold text-white">
            💬 {summary.unreminded} لم يُذكَّروا — ابدأ الجولة
          </a>
        ) : null}
        {summary.labPending > 0 ? (
          <a href={`/appointments?date=${tomorrow}&filter=lab`}
            className="rounded-xl border border-amber-400 bg-white px-3 py-1.5 text-xs font-extrabold text-amber-900">
            🧪 {summary.labPending} تنتظر تركيبةً لم تصل
          </a>
        ) : null}
      </div>
    </section>
  );
}
