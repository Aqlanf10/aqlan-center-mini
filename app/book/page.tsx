"use client";

import { useMemo, useState } from "react";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { Logo } from "@/components/Icon";
import { PERIOD_LABELS, type PreferredPeriod } from "@/lib/booking";
import { addDays } from "@/lib/schedule";

/**
 * صفحة المريض — الوحيدة التي يراها من خارج العيادة.
 *
 * هي **طلب** لا حجز، وهذا مكتوب على الزر وفي الرد بعده. الوعد الذي لا يُقطع لا يُخلَف:
 * مريض جاء ظانًّا أن له موعدًا مؤكّدًا ثم لم يجده هو نفس شكوى الإهمال التي بُنيت هذه
 * الأداة كلها لعلاجها.
 *
 * ثلاثة حقول فقط مطلوبة. كل حقل إضافي في نموذج عام يعني مريضًا يتوقف في منتصفه
 * ويتصل بالعيادة بدلًا منه — وهو ما نحاول تخفيفه لا زيادته.
 */

const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const DAYS_OFFERED = 21;

function labelFor(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  const day = WEEKDAYS[parsed.getDay()];
  return `${day} ${String(parsed.getDate()).padStart(2, "0")}/${String(parsed.getMonth() + 1).padStart(2, "0")}`;
}

export default function BookPage() {
  const clinicName = useClinicName();
  const doctor = useSetting("clinic.lead_doctor");
  const doctorTitle = useSetting("clinic.lead_doctor_title");
  const clinicPhone = useSetting("clinic.phone");
  const clinicAddress = useSetting("clinic.address");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [preferredDate, setPreferredDate] = useState("");
  const [preferredPeriod, setPreferredPeriod] = useState<PreferredPeriod>("any");
  const [website, setWebsite] = useState(""); // مصيدة البرامج الآلية
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // الأيام تُحسب في المتصفح من تاريخ جهاز المريض، والخادم يتحقق منها بتوقيت العيادة:
  // جهاز بساعة خاطئة قد يعرض يومًا ماضيًا، والخادم هو من يرفضه لا الواجهة.
  const days = useMemo(() => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return Array.from({ length: DAYS_OFFERED }, (_, index) => addDays(today, index));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, phone, reason, preferredDate, preferredPeriod, website }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر إرسال الطلب.");
        return;
      }
      setSent(true);
    } catch {
      setError("تعذّر الاتصال. تأكد من الإنترنت أو اتصل بالمركز.");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <main className="mx-auto max-w-lg p-6">
        <div className="rounded-3xl border border-success-300 bg-white p-8 text-center shadow-card">
          <Logo className="mx-auto h-14 w-14" />
          <p className="mt-4 text-2xl font-bold text-success-700">وصلنا طلبكم</p>
          <p className="mt-3 text-base leading-relaxed text-slate-600">
            سنتصل بكم لتأكيد الوقت المناسب. الموعد لا يُعتبر مؤكدًا حتى نتواصل معكم.
          </p>
          <div className="mt-6 border-t border-slate-100 pt-4">
            <p className="text-sm font-bold text-navy-900">{clinicName}</p>
            {clinicPhone ? (
              <p className="mt-1 text-xs font-semibold text-slate-500">
                للتواصل: <span className="ltr-nums">{clinicPhone}</span>
              </p>
            ) : null}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg p-4 pb-16">
      {/*
        هذه ليست شاشة داخلية — هي **وجه المركز أمام المرضى**، والرابط الذي يُرسل
        بالواتساب ويُحفظ في هواتفهم. كانت عنوانًا وسطرًا رماديًا بلا شعار ولا اسم
        طبيب ولا رقم هاتف: صفحةٌ لا تقول لمن فتحها إلى أين يرسل بياناته.
      */}
      <header className="mb-5 mt-4 text-center">
        <Logo className="mx-auto h-14 w-14" />
        <h1 className="mt-3 text-base font-bold leading-snug text-navy-900">{clinicName}</h1>
        <p className="mt-1 text-xs font-semibold text-slate-500">
          {doctor}{doctorTitle ? ` — ${doctorTitle}` : ""}
        </p>
        <p className="mt-4 text-lg font-bold text-navy-900">طلب موعد</p>
      </header>

      <form onSubmit={submit} className="rounded-3xl border border-slate-200 bg-white p-5">
        <label className="mb-1 block text-sm font-bold" htmlFor="fullName">الاسم الكامل</label>
        <input
          id="fullName"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          className="mb-4 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
          autoComplete="name"
        />

        <label className="mb-1 block text-sm font-bold" htmlFor="phone">رقم الجوال</label>
        <input
          id="phone"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          inputMode="tel"
          dir="ltr"
          placeholder="7XXXXXXXX"
          className="mb-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
          autoComplete="tel"
        />
        <p className="mb-4 text-[11px] text-slate-400">سنتصل بكم على هذا الرقم لتأكيد الموعد.</p>

        <label className="mb-1 block text-sm font-bold" htmlFor="preferredDate">اليوم المفضل (اختياري)</label>
        <select
          id="preferredDate"
          value={preferredDate}
          onChange={(event) => setPreferredDate(event.target.value)}
          className="mb-4 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
        >
          <option value="">أي يوم</option>
          {days.map((day) => (
            <option key={day} value={day}>{labelFor(day)}</option>
          ))}
        </select>

        <span className="mb-1 block text-sm font-bold">الفترة المفضلة</span>
        <div className="mb-4 flex gap-2">
          {(["morning", "evening", "any"] as PreferredPeriod[]).map((period) => (
            <button
              key={period}
              type="button"
              onClick={() => setPreferredPeriod(period)}
              className={`flex-1 rounded-xl border px-3 py-2 text-sm font-bold ${
                preferredPeriod === period
                  ? "border-brand-blue bg-brand-blue text-white"
                  : "border-slate-200 bg-white text-slate-600"
              }`}
            >
              {PERIOD_LABELS[period]}
            </button>
          ))}
        </div>

        <label className="mb-1 block text-sm font-bold" htmlFor="reason">سبب الزيارة (اختياري)</label>
        <textarea
          id="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={200}
          className="mb-4 w-full resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-brand-blue"
          placeholder="تقويم، ألم، تنظيف، متابعة…"
        />

        {/* مصيدة: مخفية عن المريض ومقروءة للبرامج الآلية التي تملأ كل حقل تجده. */}
        <input
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="pointer-events-none absolute -left-[9999px] h-0 w-0 opacity-0"
        />

        {error ? (
          <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-accent-500 py-3 text-base font-extrabold text-white transition-colors hover:bg-accent-600 disabled:opacity-40"
        >
          {busy ? "جارٍ الإرسال…" : "أرسل طلب الموعد"}
        </button>
        <p className="mt-3 text-center text-[11px] leading-relaxed text-slate-400">
          هذا طلب موعد. سنتصل بكم لتأكيد الوقت — الموعد غير مؤكد قبل تواصلنا معكم.
        </p>
        {/* من له ملف لدى العيادة يصل حسابه ومواعيده من البوابة — بلا اتصال. */}
        <p className="mt-2 text-center text-[11px] leading-relaxed text-slate-400">
          لديكم ملف لدينا؟{" "}
          <a href="/portal" className="font-bold text-navy-800 underline underline-offset-2">ادخلوا بوابة المريض</a>{" "}
          لمشاهدة حسابكم وتأكيد حضوركم.
        </p>
      </form>

      {/* بيانات التواصل: من يفتح الصفحة وهو مستعجل يتصل بدل أن ينتظر ردًّا. */}
      <footer className="mt-5 text-center text-[11px] font-semibold leading-relaxed text-slate-400">
        {clinicAddress ? <p>{clinicAddress}</p> : null}
        {clinicPhone ? (
          <p className="mt-0.5">
            للتواصل المباشر:{" "}
            <a href={`tel:${clinicPhone}`} className="font-bold text-navy-800 ltr-nums">{clinicPhone}</a>
          </p>
        ) : null}
      </footer>
    </main>
  );
}
