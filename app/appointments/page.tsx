"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dayLoad, type Appointment } from "@/lib/schedule";
import { whatsAppLink } from "@/lib/reminders";
import { useChairCount } from "@/components/SettingsProvider";
import { PageHeader } from "@/components/PageHeader";

/**
 * المواعيد — الشاشة التي تعالج «ينتظرون أيامًا».
 *
 * الحجز في ثلاث خطوات: اختر المريض (أو أنشئه في نفس الحقل)، اختر الوقت والمدة، احجز.
 * والمدة ليست تفصيلًا: شدّ السلك عشر دقائق واللصق ستون، وحجزهما كأنهما نصف ساعة هو
 * السبب المباشر لانهيار يوم عيادة التقويم قبل الظهر.
 */

/** مدد واقعية لعيادة تقويم تعمل عامًا أيضًا — تُختصر النقر وتجعل الطاقة صادقة. */
const DURATIONS = [
  { minutes: 15, label: "شدّ سلك — ١٥ د" },
  { minutes: 30, label: "متابعة — ٣٠ د" },
  { minutes: 45, label: "حشوة — ٤٥ د" },
  { minutes: 60, label: "لصق/تركيب — ٦٠ د" },
  { minutes: 90, label: "إجراء طويل — ٩٠ د" },
];

/** تاريخ اليوم بتوقيت الجهاز — والجهاز في العيادة، فتوقيته توقيت العيادة. */
function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

interface Patient { id: number; patientNumber: string; fullName: string; phone: string | null }

const STATUS_LABEL: Record<string, string> = {
  booked: "محجوز", arrived: "وصل", done: "تم", cancelled: "ملغى", no_show: "لم يحضر",
};

export default function AppointmentsPage() {
  const CHAIRS = useChairCount();
  const [date, setDate] = useState(todayLocal);
  const [items, setItems] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Patient[]>([]);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [phone, setPhone] = useState("");
  const [time, setTime] = useState("10:00");
  const [duration, setDuration] = useState(30);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/appointments?date=${target}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setItems(payload as Appointment[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(date); }, [date, load]);

  // البحث بعد توقف الكتابة لا مع كل حرف: الاستقبال تكتب اسمًا كاملًا، وطلبٌ لكل حرف
  // يُثقل الاتصال ويعيد نتائج قديمة بعد الجديدة.
  useEffect(() => {
    if (patient || query.trim().length < 2) { setMatches([]); return; }
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/patients?q=${encodeURIComponent(query.trim())}`, { cache: "no-store" });
        if (response.ok) setMatches(await response.json());
      } catch { /* البحث الفاشل يترك القائمة كما هي */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, patient]);

  const load_ = useMemo(() => dayLoad(items, date, CHAIRS), [items, date]);

  const act = useCallback(async (run: () => Promise<Response>, after?: () => void) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setHint(null);
    try {
      const response = await run();
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر تنفيذ الإجراء.");
        if (payload?.suggestionMessage) setHint(payload.suggestionMessage);
        if (payload?.suggestion) setTime(payload.suggestion);
      } else {
        setError(null); after?.();
      }
      await load(date);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      inFlight.current = false; setBusy(false);
    }
  }, [date, load]);

  const book = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    let target = patient;
    if (!target) {
      const name = query.trim();
      if (!name) return;
      // مريض جديد يُنشأ من نفس الحقل: إجبار الاستقبال على شاشة ثانية لإضافة مريض هو
      // ما يجعلها تكتب الاسم في ورقة بدل النظام.
      const response = await fetch("/api/patients", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: name, phone: phone.trim() }),
      });
      if (!response.ok) { setError("تعذّر إنشاء المريض."); return; }
      target = await response.json();
      setPatient(target);
    }
    await act(() => fetch("/api/appointments", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patientId: target!.id, date, time, durationMinutes: duration }),
    }), () => { setPatient(null); setQuery(""); setPhone(""); setMatches([]); });
  }, [act, date, duration, patient, phone, query, time]);

  const shift = (days: number) => {
    const next = new Date(`${date}T12:00:00`);
    next.setDate(next.getDate() + days);
    setDate(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`);
  };

  return (
    <main className="mx-auto max-w-4xl p-4 pb-24">
      <PageHeader
        title="المواعيد"
        subtitle="الحجز محكوم بعدد الكراسي — لا يُوعَد بما لا يتسع له اليوم."
      />

      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => shift(-1)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold">السابق</button>
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)}
          className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-center text-sm font-bold outline-none focus:border-brand-blue" />
        <button onClick={() => shift(1)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold">التالي</button>
      </div>

      <div className={`mb-4 rounded-2xl border p-3 ${load_.percent >= 90 ? "border-red-300 bg-red-50" : load_.percent >= 70 ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"}`}>
        <div className="flex items-center justify-between text-xs font-bold">
          <span>حِمل اليوم</span>
          <span>{load_.booked} موعدًا · {Math.round(load_.bookedMinutes / 60 * 10) / 10} من {Math.round(load_.capacityMinutes / 60)} ساعة</span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200">
          <div className={`h-full ${load_.percent >= 90 ? "bg-red-500" : load_.percent >= 70 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${Math.min(100, load_.percent)}%` }} />
        </div>
      </div>

      <form onSubmit={book} className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-bold">حجز موعد</h2>
        <div className="relative">
          <input
            value={patient ? patient.fullName : query}
            onChange={(event) => { setPatient(null); setQuery(event.target.value); }}
            placeholder="اسم المريض — اكتب للبحث أو لإضافة جديد"
            aria-label="اسم المريض"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
          />
          {matches.length > 0 && !patient ? (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
              {matches.map((match) => (
                <li key={match.id}>
                  <button type="button" onClick={() => { setPatient(match); setMatches([]); }}
                    className="w-full px-3 py-2 text-right text-sm hover:bg-slate-50">
                    <span className="font-bold">{match.fullName}</span>
                    <span className="mr-2 text-xs text-slate-400">{match.patientNumber}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {!patient ? (
          <input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel"
            placeholder="الهاتف (لمريض جديد)" aria-label="هاتف المريض"
            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
        ) : null}

        <div className="mt-2 flex flex-wrap gap-2">
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} aria-label="وقت الموعد"
            className="w-32 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue" />
          <select value={duration} onChange={(event) => setDuration(Number(event.target.value))} aria-label="مدة الموعد"
            className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue">
            {DURATIONS.map((option) => (
              <option key={option.minutes} value={option.minutes}>{option.label}</option>
            ))}
          </select>
          <button type="submit" disabled={busy || (!patient && !query.trim())}
            className="rounded-xl bg-brand-orange px-5 py-2 text-sm font-bold text-white disabled:opacity-50">
            احجز
          </button>
        </div>
      </form>

      {error ? <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}
      {hint ? <p className="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-bold text-blue-800">{hint}</p> : null}

      <section aria-label="مواعيد اليوم">
        <h2 className="mb-2 text-sm font-bold">مواعيد اليوم ({items.length})</h2>
        {loading ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
        ) : items.length === 0 ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">لا مواعيد في هذا اليوم.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id} className={`rounded-2xl border p-3 ${item.status === "cancelled" || item.status === "no_show" ? "border-slate-200 bg-slate-50 opacity-60" : "border-slate-200 bg-white"}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-xl bg-navy-800 px-2.5 py-1 text-xs font-extrabold text-white">{item.scheduledTime}</span>
                  <div className="min-w-0 flex-1">
                    <a href={`/patients/${item.patientId}`} className="block truncate text-base font-extrabold underline decoration-slate-300 underline-offset-4">
                      {item.patientName}
                    </a>
                    <p className="text-xs text-slate-500">{item.durationMinutes} دقيقة · {STATUS_LABEL[item.status] ?? item.status}</p>
                  </div>
                  {item.status === "booked" || item.status === "no_show" ? (
                    <div className="flex flex-wrap gap-1.5">
                      <ReminderButton item={item} onSent={() => act(() => fetch(`/api/appointments/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reminded" }) }))} />
                    </div>
                  ) : null}
                  {item.status === "booked" ? (
                    <div className="flex gap-1.5">
                      <button onClick={() => act(() => fetch(`/api/appointments/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "arrive" }) }))}
                        disabled={busy} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">وصل</button>
                      <button onClick={() => act(() => fetch(`/api/appointments/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "no_show" }) }))}
                        disabled={busy} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-40">لم يحضر</button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}


/**
 * زر واتساب.
 *
 * رابط حقيقي لا زر ينادي واجهة برمجية: الرابط يفتح واتساب على جهاز الموظفة بالرسالة
 * مكتوبة، فتراها وتضغط إرسال. لا يستطيع أن يفشل صامتًا كما تفشل بوابة رسائل غير مضبوطة.
 *
 * وحين لا يصلح الرقم يظهر السبب بدل زر معطّل بلا تفسير — «بلا رقم» تخبر الاستقبال
 * بما عليها فعله: اسأل المريض عن رقمه.
 */
function ReminderButton({ item, onSent }: { item: Appointment; onSent: () => void }) {
  const link = whatsAppLink(item, item.status === "no_show" ? "missed" : "upcoming");
  if (!link) {
    return <span className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-400">بلا رقم</span>;
  }
  const reminded = Boolean(item.reminderSentAt);
  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onSent}
      className={`rounded-xl px-3 py-2 text-xs font-bold ${reminded ? "border border-emerald-300 bg-emerald-50 text-emerald-700" : "bg-[#25D366] text-white"}`}
    >
      {reminded ? "ذُكِّر ✓" : "تذكير واتساب"}
    </a>
  );
}
