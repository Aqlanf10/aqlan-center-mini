"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { PERIOD_LABELS, confirmationText, type BookingRequest } from "@/lib/booking";
import { friendlyDate, friendlyTime, toWhatsAppNumber } from "@/lib/reminders";
import { minutesSince } from "@/lib/flow";
import { PageHeader } from "@/components/PageHeader";
import { minutesText } from "@/lib/report";

/**
 * صندوق طلبات المرضى.
 *
 * هذه هي النصف الثاني من الحجز الإلكتروني، وهي النصف الذي يقرر هل ينفع أم يضر: طلب
 * يصل ولا يراه أحد أسوأ من ألا يكون هناك حجز إلكتروني أصلًا — لأن المريض أرسل وانتظر
 * ردًّا لم يأتِ، وهي بالضبط الشكوى التي نعالجها.
 *
 * لذلك: الأقدم أولًا، ومدّة الانتظار ظاهرة بالساعات عند كل طلب، وزر واتساب جاهز بنص
 * مكتوب — لأن الخطوة التي تحتاج كتابة يدوية هي الخطوة التي لا تُنفَّذ في يوم مزدحم.
 */

const REFRESH_MS = 60_000;

function hoursWaiting(createdAt: string, now: Date): string {
  const minutes = minutesSince(createdAt, now);
  if (minutes < 60) return `منذ ${minutesText(minutes)}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;
  return `منذ ${Math.floor(hours / 24)} يوم`;
}

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function RequestsPage() {
  const CLINIC_NAME = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const [requests, setRequests] = useState<BookingRequest[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [date, setDate] = useState(todayLocal());
  const [time, setTime] = useState("10:00");
  const [duration, setDuration] = useState(30);
  const [confirmed, setConfirmed] = useState<{ id: number; link: string | null } | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async (showSpinner = false, keepError = false) => {
    if (showSpinner) setLoading(true);
    try {
      const response = await fetch("/api/booking-requests?status=new", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setRequests(payload as BookingRequest[]);
      if (!keepError) setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(true); }, [load]);
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000);
    const poll = setInterval(() => { void load(false); }, REFRESH_MS);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [load]);

  const openConfirm = useCallback((request: BookingRequest) => {
    setOpenId(request.id);
    setConfirmed(null);
    setError(null);
    setDate(request.preferredDate ?? todayLocal());
    setTime(request.preferredPeriod === "evening" ? "17:00" : "10:00");
    setDuration(30);
  }, []);

  const confirm = useCallback(async (request: BookingRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch(`/api/booking-requests/${request.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", date, time, durationMinutes: duration }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        // اقتراح وقت بديل بدل رفض مجرّد: الاستقبال تقول للمريض وقتًا في نفس المكالمة.
        setError([payload?.message, payload?.suggestionMessage].filter(Boolean).join(" ") || "تعذّر التأكيد.");
        if (typeof payload?.suggestion === "string") setTime(payload.suggestion);
        return;
      }
      const number = toWhatsAppNumber(request.phone);
      const text = confirmationText({
        patientName: request.fullName,
        whenText: `${friendlyDate(date)} الساعة ${friendlyTime(time)}`,
        clinicName: CLINIC_NAME,
        clinicPhone,
      });
      setConfirmed({
        id: request.id,
        link: number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null,
      });
      setOpenId(null);
      setError(null);
      await load(false);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [date, time, duration, load, CLINIC_NAME, clinicPhone]);

  const reject = useCallback(async (id: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch(`/api/booking-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) setError(payload?.message ?? "تعذّر الإغلاق.");
      else setError(null);
      await load(false, true);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [load]);

  const oldest = useMemo(() => (requests[0] ? minutesSince(requests[0].createdAt, now) : 0), [requests, now]);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <PageHeader
        title="طلبات المرضى"
        subtitle="وصلت من صفحة الحجز، الأقدم أولًا"
        links={[{ href: "/book", label: "افتح صفحة الحجز" }]}
      />

      {oldest >= 240 ? (
        <p className="mb-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
          أقدم طلب مضى عليه أكثر من أربع ساعات بلا رد.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {confirmed ? (
        <div className="mb-4 rounded-2xl border border-emerald-300 bg-emerald-50 p-4">
          <p className="text-sm font-bold text-emerald-800">تم الحجز. أبلغ المريض الآن:</p>
          {confirmed.link ? (
            <a
              href={confirmed.link}
              target="_blank"
              rel="noopener"
              className="mt-2 inline-block rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white"
            >
              إرسال التأكيد بواتساب
            </a>
          ) : (
            <p className="mt-1 text-sm text-emerald-700">الرقم لا يصلح لواتساب — اتصل به هاتفيًا.</p>
          )}
        </div>
      ) : null}

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : requests.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
          لا توجد طلبات جديدة.
        </p>
      ) : (
        <ul className="space-y-3">
          {requests.map((request) => (
            <li key={request.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-[10rem] flex-1">
                  <p className="text-base font-extrabold">{request.fullName}</p>
                  <p className="text-xs text-slate-500" dir="ltr">{request.phone}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {request.preferredDate ? friendlyDate(request.preferredDate) : "أي يوم"}
                    {" · "}
                    {PERIOD_LABELS[request.preferredPeriod]}
                    {" · "}
                    {hoursWaiting(request.createdAt, now)}
                  </p>
                  {request.reason ? (
                    <p className="mt-1 text-sm text-slate-600">{request.reason}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    onClick={() => openConfirm(request)}
                    disabled={busy}
                    className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white disabled:opacity-30"
                  >
                    حدّد موعدًا
                  </button>
                  <button
                    onClick={() => reject(request.id)}
                    disabled={busy}
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600 disabled:opacity-30"
                  >
                    إغلاق
                  </button>
                </div>
              </div>

              {openId === request.id ? (
                <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap gap-2">
                    <label className="flex-1">
                      <span className="mb-1 block text-[11px] font-bold text-slate-500">اليوم</span>
                      <input
                        type="date"
                        value={date}
                        onChange={(event) => setDate(event.target.value)}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="w-28">
                      <span className="mb-1 block text-[11px] font-bold text-slate-500">الساعة</span>
                      <input
                        type="time"
                        value={time}
                        onChange={(event) => setTime(event.target.value)}
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
                        value={duration}
                        onChange={(event) => setDuration(Number(event.target.value))}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                      />
                    </label>
                  </div>
                  <button
                    onClick={() => confirm(request)}
                    disabled={busy}
                    className="mt-3 w-full rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
                  >
                    تأكيد الحجز
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
