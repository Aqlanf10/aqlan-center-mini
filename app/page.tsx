"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  calledVisits,
  chairRows,
  daySummary,
  firstFreeChair,
  minutesSince,
  waitingRows,
  type Visit,
  type WaitLevel,
} from "@/lib/flow";
import { useChairCount, useClinicName, useSetting } from "@/components/SettingsProvider";
import { sessionAfterWeeks } from "@/lib/schedule";
import { friendlyDate, friendlyTime, toWhatsAppNumber } from "@/lib/reminders";
import { confirmationText } from "@/lib/booking";
import { minutesText, shortMinutes } from "@/lib/report";
import { StatCard as Stat } from "@/components/PageHeader";

/** ملفٌّ مرشَّح لِما تكتبه الاستقبال في حقل الوصول. */
interface PatientMatch {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
  medicalAlert: string | null;
}

/**
 * شاشة واحدة، عمدًا.
 *
 * النظام الأساسي يملك شاشة تشغيل يومي فيها ثمانية تبويبات، ولم يستخدمها المالك قط.
 * السبب المعلن: ميزات ناقصة وتضارب. فالرهان هنا معاكس تمامًا — شاشة واحدة تُتعلَّم في
 * دقيقة: اكتب اسمًا، اضغط «وصل»، ثم اضغط كرسيًا. لا قوائم ولا إعدادات ولا تدريب.
 */

/** تاريخ اليوم من ساعة الجهاز — والجهاز في العيادة، فتوقيته توقيت العيادة. */
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * دورات المتابعة كما ينطقها الطبيب: «بعد أربعة أسابيع».
 *
 * النص مكتوب لكل خيار لا مُركَّب من رقم: العربية تثنّي — «أسبوعين» لا «2 أسابيع» —
 * وشاشة يستخدمها الطبيب أمام مريضه لا تكتب عربية مكسورة.
 */
const FOLLOW_UP_WEEKS: { weeks: number; label: string }[] = [
  { weeks: 2, label: "بعد أسبوعين" },
  { weeks: 3, label: "بعد ٣ أسابيع" },
  { weeks: 4, label: "بعد ٤ أسابيع" },
  { weeks: 6, label: "بعد ٦ أسابيع" },
];
const REFRESH_MS = 20_000;

const LEVEL_STYLES: Record<WaitLevel, string> = {
  calm: "border-slate-200 bg-white",
  warning: "border-amber-300 bg-amber-50",
  critical: "border-red-300 bg-red-50",
};
const LEVEL_BADGE: Record<WaitLevel, string> = {
  calm: "bg-slate-100 text-slate-600",
  warning: "bg-amber-200 text-amber-900",
  critical: "bg-red-500 text-white",
};

export default function FlowBoard() {
  const CHAIR_COUNT = useChairCount();
  const CLINIC_NAME = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const [visits, setVisits] = useState<Visit[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  /*
   * مرشّحو الملفّات لِما تكتبه الاستقبال.
   *
   * **العلّة التي يعالجها هذا**: مريضٌ مسجَّل يصل بلا رقم جوال كان يُنشأ له ملفٌ
   * ثانٍ عند التوقيع — فتذهب فاتورته ومخططه إلى ملفٍ غير ملفّه. ولا يطابق البرنامج
   * بالاسم من تلقاء نفسه: «محمد أحمد» اسمُ رجلين، ودمجُ ملفَّي شخصين أسوأ من تكرار
   * ملفٍّ واحد. فالاختيار للاستقبال، والبرنامج يعرض ولا يقرّر.
   */
  const [matches, setMatches] = useState<PatientMatch[]>([]);
  const [chosen, setChosen] = useState<PatientMatch | null>(null);
  // الزيارة التي انتهت للتو، معروضة لحجز جلستها القادمة والمريض ما زال واقفًا.
  const [justFinished, setJustFinished] = useState<Visit | null>(null);
  const [nextDate, setNextDate] = useState("");
  const [nextTime, setNextTime] = useState("10:00");
  const [nextDuration, setNextDuration] = useState(30);
  const [nextPhone, setNextPhone] = useState("");
  const [nextBooked, setNextBooked] = useState<{ link: string | null; whenText: string } | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const response = await fetch("/api/visits", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setVisits(payload as Visit[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(true); }, [load]);

  // الأرقام تتقدّم كل عشر ثوانٍ بلا طلب شبكة: مدة الانتظار حساب محلي، وإعادة تحميلها
  // من الخادم كل ثانية كانت ستُثقل الاتصال بلا فائدة. القائمة نفسها تُحدَّث كل عشرين ثانية.
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 10_000);
    const poll = setInterval(() => { void load(false); }, REFRESH_MS);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [load]);

  const waiting = useMemo(() => waitingRows(visits, now), [visits, now]);
  const chairs = useMemo(() => chairRows(CHAIR_COUNT, visits, now), [visits, now]);
  const summary = useMemo(() => daySummary(CHAIR_COUNT, visits, now), [visits, now]);
  const called = useMemo(() => calledVisits(visits), [visits]);
  const freeChair = useMemo(() => firstFreeChair(CHAIR_COUNT, visits), [visits]);

  // كل إجراء يمرّ من هنا: قفل واحد يمنع الضغط المزدوج على جهاز، والخادم يمنع
  // التعارض بين جهازين. الاثنان لازمان — الاستقبال على الشاشة والطبيب على هاتفه.
  const act = useCallback(async (run: () => Promise<Response>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await run();
      const payload = await response.json().catch(() => null);
      if (!response.ok) setError(payload?.message ?? "تعذّر تنفيذ الإجراء.");
      else setError(null);
      await load(false);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [load]);

  // البحث يتأخّر قليلًا عن الكتابة: استدعاءٌ عند كل حرف يُثقل الخادم بلا فائدة.
  useEffect(() => {
    if (chosen) return;
    const term = name.trim();
    if (term.length < 2) { setMatches([]); return; }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/patients?q=${encodeURIComponent(term)}`, { cache: "no-store" });
          if (!response.ok) return;
          const payload = await response.json();
          setMatches(Array.isArray(payload) ? (payload as PatientMatch[]).slice(0, 5) : []);
        } catch {
          // تعذّر البحث لا يمنع التسجيل — الاقتراح مساعدةٌ لا شرط.
        }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [name, chosen]);

  const addPatient = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await act(() => fetch("/api/visits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patientName: trimmed,
        patientPhone: phone.trim(),
        patientId: chosen?.id ?? null,
      }),
    }));
    setName("");
    setPhone("");
    setChosen(null);
    setMatches([]);
  }, [act, name, phone, chosen]);

  const call = useCallback((id: number, chair: number) => act(() => fetch(`/api/visits/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "call", chair }),
  })), [act]);

  const unCall = useCallback((id: number) => act(() => fetch(`/api/visits/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "return" }),
  })), [act]);

  const seat = useCallback((id: number, chair: number) => act(() => fetch(`/api/visits/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "seat", chair }),
  })), [act]);

  /**
   * إنهاء الزيارة يفتح فورًا حجز الجلسة القادمة.
   *
   * هذه اللحظة — والمريض ما زال واقفًا أمام الاستقبال ومعه قراره — هي الفرق بين
   * مريض تقويم يعود بعد أربعة أسابيع ومريضٍ يختفي شهرين ثم يشكو أن العيادة لم تتابعه.
   * «سنتصل بك» ليست خطة: هي مكالمة لن تُجرى في يوم مزدحم.
   */
  const finish = useCallback(async (visit: Visit) => {
    await act(() => fetch(`/api/visits/${visit.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "finish" }),
    }));
    setNextBooked(null);
    setJustFinished(visit);
    setNextPhone(visit.patientPhone ?? "");
    // أربعة أسابيع هي دورة متابعة التقويم المعتادة، وهي الاختيار الأكثر تكرارًا.
    setNextDate(sessionAfterWeeks(localToday(), 4));
    setNextTime("10:00");
    setNextDuration(30);
  }, [act]);

  const bookNextSession = useCallback(async () => {
    if (!justFinished || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch(`/api/visits/${justFinished.id}/next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: nextDate, time: nextTime, durationMinutes: nextDuration, phone: nextPhone,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError([payload?.message, payload?.suggestionMessage].filter(Boolean).join(" ") || "تعذّر الحجز.");
        if (typeof payload?.suggestion === "string") setNextTime(payload.suggestion);
        return;
      }
      const whenText = `${friendlyDate(nextDate)} الساعة ${friendlyTime(nextTime)}`;
      const number = toWhatsAppNumber(payload?.phone ?? nextPhone);
      const text = confirmationText({
        patientName: justFinished.patientName,
        whenText,
        clinicName: CLINIC_NAME,
        clinicPhone,
      });
      setNextBooked({ whenText, link: number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null });
      setJustFinished(null);
      setError(null);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [justFinished, nextDate, nextTime, nextDuration, nextPhone, CLINIC_NAME, clinicPhone]);

  return (
    <main className="mx-auto max-w-5xl p-4 pb-24">
      {/*
        العنوان سطرًا والروابط سطرًا تحته.
        كانت الروابط بجانب العنوان، فلمّا صارت أربعة انكسر اسم المركز إلى أربعة أسطر
        على شاشة الهاتف — والاستقبال تعمل على الهاتف. كل رابط يُضاف لاحقًا يقع في
        السطر السفلي ولا يزاحم العنوان.
      */}
      <header className="mb-4">
        <h1 className="text-xl font-extrabold leading-tight">اليوم</h1>
        <p className="text-xs text-slate-500">من ينتظر، ومنذ متى، وهل الكرسي فارغ</p>
      </header>

      <section className="mb-4 grid grid-cols-3 gap-2" aria-label="ملخص اليوم">
        <Stat label="ينتظرون الآن" value={summary.waiting} tone={summary.waiting > 0 ? "warn" : "calm"} />
        <Stat
          label="أطول انتظار"
          value={shortMinutes(summary.longestWaitMinutes)}
          tone={summary.longestWaitMinutes >= 30 ? "bad" : summary.longestWaitMinutes >= 15 ? "warn" : "calm"}
        />
        <Stat label="كراسٍ فارغة" value={summary.freeChairs} tone={summary.freeChairs > 0 && summary.waiting > 0 ? "bad" : "calm"} />
      </section>

      {summary.freeChairs > 0 && summary.waiting > 0 ? (
        <p className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
          كرسي فارغ ومريض ينتظر. أدخِل التالي الآن.
        </p>
      ) : null}

      <form onSubmit={addPatient} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">وصل مريض</h2>
        <div className="flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(event) => { setName(event.target.value); setChosen(null); }}
            placeholder="اسم المريض"
            aria-label="اسم المريض"
            autoComplete="off"
            className="min-w-[180px] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
          />
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="الهاتف (اختياري)"
            aria-label="هاتف المريض"
            inputMode="tel"
            className="w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-xl bg-brand-orange px-5 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            وصل
          </button>
        </div>

        {chosen ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">
            <span>مربوط بملف {chosen.patientNumber}</span>
            {chosen.medicalAlert ? (
              <span className="rounded-lg bg-red-100 px-2 py-0.5 text-red-800">
                تنبيه طبي: {chosen.medicalAlert}
              </span>
            ) : null}
            <button type="button" onClick={() => setChosen(null)}
              className="mr-auto rounded-lg border border-emerald-300 bg-white px-2 py-0.5 font-bold text-emerald-700">
              فكّ الربط
            </button>
          </p>
        ) : matches.length > 0 ? (
          <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
            <p className="mb-1 text-[11px] font-bold text-slate-500">
              ملفّات مطابقة — اختر ملفّه إن كان مسجّلًا، فلا يُنشأ له ملفٌ ثانٍ:
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {matches.map((match) => (
                <li key={match.id}>
                  <button type="button"
                    onClick={() => {
                      setChosen(match);
                      setName(match.fullName);
                      if (match.phone) setPhone(match.phone);
                      setMatches([]);
                    }}
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-navy-800">
                    {match.fullName}
                    <span className="mr-1.5 font-normal text-slate-500">
                      {match.patientNumber}{match.phone ? ` · ${match.phone}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </form>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {/*
        الجلسة القادمة — تُفتح لحظة الانتهاء لا في شاشة أخرى.
        مريض التقويم يحتاج زيارة كل ثلاثة أو أربعة أسابيع، وتأجيل الحجز إلى «سنتصل بك»
        يعني اختفاءه شهرين ثم شكواه أن العيادة لا تتابع. النافذة الوحيدة التي يُحجز
        فيها فعلًا هي وهو واقف أمام الاستقبال.
      */}
      {justFinished ? (
        <section className="mb-5 rounded-2xl border-2 border-brand-blue bg-white p-4" aria-label="الجلسة القادمة">
          <h2 className="text-sm font-bold">الجلسة القادمة لـ {justFinished.patientName}</h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {FOLLOW_UP_WEEKS.map((option) => {
              const candidate = sessionAfterWeeks(localToday(), option.weeks);
              return (
                <button
                  key={option.weeks}
                  onClick={() => setNextDate(candidate)}
                  className={`rounded-xl border px-3 py-2 text-xs font-bold ${
                    nextDate === candidate
                      ? "border-brand-blue bg-brand-blue text-white"
                      : "border-slate-200 bg-white text-slate-600"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <label className="min-w-[9rem] flex-1">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">اليوم</span>
              <input
                type="date"
                value={nextDate}
                onChange={(event) => setNextDate(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="w-28">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">الساعة</span>
              <input
                type="time"
                value={nextTime}
                onChange={(event) => setNextTime(event.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="w-24">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">دقيقة</span>
              <input
                type="number"
                min={5}
                max={480}
                step={5}
                value={nextDuration}
                onChange={(event) => setNextDuration(Number(event.target.value))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
          </div>
          {!justFinished.patientPhone ? (
            <label className="mt-2 block">
              <span className="mb-1 block text-[11px] font-bold text-slate-500">
                رقم الجوال — بلا رقم لا يمكن تذكيره بالموعد
              </span>
              <input
                value={nextPhone}
                onChange={(event) => setNextPhone(event.target.value)}
                inputMode="tel"
                dir="ltr"
                placeholder="7XXXXXXXX"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button
              onClick={bookNextSession}
              disabled={busy || !nextDate}
              className="flex-1 rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
            >
              احجز الجلسة القادمة
            </button>
            <button
              onClick={() => setJustFinished(null)}
              disabled={busy}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600"
            >
              ليس الآن
            </button>
          </div>
        </section>
      ) : null}

      {nextBooked ? (
        <div className="mb-5 rounded-2xl border border-emerald-300 bg-emerald-50 p-4">
          <p className="text-sm font-bold text-emerald-800">حُجزت الجلسة: {nextBooked.whenText}</p>
          {nextBooked.link ? (
            <a
              href={nextBooked.link}
              target="_blank"
              rel="noopener"
              onClick={() => setNextBooked(null)}
              className="mt-2 inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white"
            >
              أرسل الموعد بواتساب
            </a>
          ) : (
            <p className="mt-1 text-sm text-emerald-700">لا يوجد رقم صالح — ذكّره هاتفيًا.</p>
          )}
        </div>
      ) : null}

      <section className="mb-5" aria-label="الكراسي">
        <h2 className="mb-2 text-sm font-bold">الكراسي</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {chairs.map((chair) => (
            <div key={chair.chair} className={`rounded-2xl border p-4 ${chair.occupant ? "border-brand-blue bg-white" : "border-dashed border-slate-300 bg-slate-50"}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-500">كرسي {chair.chair}</span>
                {chair.occupant ? (
                  <span className="rounded-full bg-brand-blue px-2 py-0.5 text-[11px] font-bold text-white">{shortMinutes(chair.busyMinutes)}</span>
                ) : chair.calledFor ? (
                  <span className="text-[11px] font-bold text-brand-orange">محجوز بالنداء</span>
                ) : (
                  <span className="text-[11px] font-bold text-emerald-600">فارغ</span>
                )}
              </div>
              {chair.occupant ? (
                <>
                  {chair.occupant.patientId ? (
                    <a href={`/patients/${chair.occupant.patientId}`} className="mt-1 block truncate text-base font-extrabold underline decoration-slate-300 underline-offset-4">
                      {chair.occupant.patientName}
                    </a>
                  ) : (
                    <p className="mt-1 truncate text-base font-extrabold">{chair.occupant.patientName}</p>
                  )}
                  {/*
                    زرّان لا واحد: «انتهى» ينهي التشغيل، و«وثّق وأغلق» يفتح التوثيق
                    السريري الذي يولّد الفاتورة. وفصلهما مقصود — الاستقبال تُنهي
                    الجلوس على الكرسي، والطبيب يوثّق ويوقّع. ودمجهما في زرّ واحد
                    يعني إمّا أن توقّع الاستقبال على تشخيص، أو أن يبقى الكرسي مشغولًا
                    حتى يفرغ الطبيب للكتابة.
                  */}
                  <div className="mt-3 flex gap-1.5">
                    <a
                      href={`/visits/${chair.occupant.id}`}
                      className="flex-1 rounded-xl bg-navy-900 py-2 text-center text-sm font-bold text-white"
                    >
                      وثّق وأغلق
                    </a>
                    <button
                      onClick={() => finish(chair.occupant!)}
                      disabled={busy}
                      className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold disabled:opacity-50"
                    >
                      انتهى
                    </button>
                  </div>
                </>
              ) : chair.calledFor ? (
                <p className="mt-1 truncate text-sm font-bold text-brand-orange">
                  نُودي على {chair.calledFor.patientName} — في الطريق
                </p>
              ) : (
                <p className="mt-1 text-sm text-slate-400">لا أحد على هذا الكرسي</p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/*
        من نُودي عليه ولم يجلس بعد.
        قسم مستقل عمدًا: هؤلاء ليسوا منتظرين — الشاشة نادت أسماءهم والصالة سمعت — ولا
        هم على الكراسي. تركهم في قائمة الانتظار كان يعني نداءً ثانيًا على من هو في الطريق.
      */}
      {called.length > 0 ? (
        <section className="mb-5" aria-label="نُودي عليهم">
          <h2 className="mb-2 text-sm font-bold">نُودي عليهم ({called.length})</h2>
          <ul className="space-y-2">
            {called.map((visit) => {
              const sinceCall = minutesSince(visit.calledAt, now);
              return (
                <li key={visit.id} className="rounded-2xl border border-brand-orange bg-orange-50 p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="rounded-full bg-brand-orange px-2.5 py-1 text-xs font-extrabold text-white">
                      كرسي {visit.chair}
                    </span>
                    <div className="min-w-[9rem] flex-1">
                      <p className="truncate text-base font-extrabold">{visit.patientName}</p>
                      <p className="text-xs text-slate-500">
                        {sinceCall === 0 ? "نُودي الآن" : `مضى على النداء ${minutesText(sinceCall)}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        onClick={() => seat(visit.id, visit.chair ?? 0)}
                        disabled={busy || !visit.chair}
                        className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white disabled:opacity-30"
                      >
                        دخل الكرسي
                      </button>
                      <button
                        onClick={() => unCall(visit.id)}
                        disabled={busy}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-30"
                      >
                        لم يحضر
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-label="قائمة الانتظار">
        <h2 className="mb-2 text-sm font-bold">قائمة الانتظار ({waiting.length})</h2>
        {loading ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
        ) : waiting.length === 0 ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
            لا أحد ينتظر الآن.
          </p>
        ) : (
          <ul className="space-y-2">
            {waiting.map((row) => (
              <li key={row.visit.id} className={`rounded-2xl border p-3 ${LEVEL_STYLES[row.level]}`}>
                {/* يلتف على الهاتف: أزرار النداء بجانب الاسم كانت تقصّ «محمد أحمد الشرعبي»
                    إلى «محمد أح…»، والاستقبال تنادي على اسم لا تراه كاملًا. */}
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-extrabold ${LEVEL_BADGE[row.level]}`}>
                    {shortMinutes(row.waitedMinutes)}
                  </span>
                  <div className="min-w-[9rem] flex-1">
                    {/* الاسم رابط إلى الملف حين يكون للمريض سجل: الاستقبال تحتاج
                        ملاحظته وتاريخه وهو أمامها، لا بعد أن يدخل الكرسي. */}
                    {row.visit.patientId ? (
                      <a href={`/patients/${row.visit.patientId}`} className="block truncate text-base font-extrabold underline decoration-slate-300 underline-offset-4">
                        {row.visit.patientName}
                      </a>
                    ) : (
                      <p className="truncate text-base font-extrabold">{row.visit.patientName}</p>
                    )}
                    {row.visit.patientPhone ? (
                      <p className="text-xs text-slate-500" dir="ltr">{row.visit.patientPhone}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {chairs.map((chair) => (
                      <button
                        key={chair.chair}
                        onClick={() => call(row.visit.id, chair.chair)}
                        disabled={busy || Boolean(chair.occupant) || Boolean(chair.calledFor)}
                        className="rounded-xl bg-brand-orange px-3 py-2 text-xs font-bold text-white disabled:opacity-30"
                      >
                        نادِ · كرسي {chair.chair}
                      </button>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-6 text-center text-[11px] text-slate-400">
        {freeChair ? `الكرسي ${freeChair} جاهز` : "الكرسيان مشغولان"} · أُنجز اليوم: {summary.done}
      </p>
    </main>
  );
}

