"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { PERIOD_LABELS, confirmationText, type BookingRequest } from "@/lib/booking";
import { friendlyDate, friendlyTime, toWhatsAppNumber } from "@/lib/reminders";
import { minutesSince } from "@/lib/flow";
import { PageHeader } from "@/components/PageHeader";
import type { publicBookingCatalog } from "@/lib/public-booking";
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

type Review = { candidates: { id: number; fullName: string; patientNumber: string }[]; patientId: number | null;
  cases: { id: number; title: string; specialty: string; doctorId: number | null; doctorName: string | null }[];
  nearby: { id: number; date: string; time: string; status: string }[] };

export default function RequestsPage() {
  const CLINIC_NAME = useClinicName();
  const clinicPhone = useSetting("clinic.phone");
  const [requests, setRequests] = useState<BookingRequest[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof publicBookingCatalog>> | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [patientId, setPatientId] = useState("");
  const [caseId, setCaseId] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [availableTimes, setAvailableTimes] = useState<string[]>([]);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [refreshReview, setRefreshReview] = useState(0);
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
    fetch("/api/book", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("تعذّر تحميل الخدمات والأطباء.");
      setCatalog(await response.json());
    }).catch(error => setError(error.message));
  }, []);
  useEffect(() => {
    if (!openId || !date) return;
    const controller = new AbortController();
    setReviewLoading(true);
    const query = new URLSearchParams({ date, ...(patientId ? { patientId } : {}) });
    fetch(`/api/booking-requests/${openId}?${query}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message);
      if (!controller.signal.aborted) setReview(payload);
    }).catch(error => { if (!controller.signal.aborted) { setReview(null); setError(error.message); } })
      .finally(() => { if (!controller.signal.aborted) setReviewLoading(false); });
    return () => controller.abort();
  }, [openId, date, patientId, refreshReview]);
  useEffect(() => {
    setAvailableTimes([]);
    if (!openId || !doctorId || !serviceId || !date) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ date, doctorId, serviceId, durationMinutes: String(duration) });
    fetch(`/api/appointments/availability?${query}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message);
      if (!controller.signal.aborted) { setAvailableTimes(payload.slots.filter((slot: { status: string }) => slot.status === "available").map((slot: { time: string }) => slot.time)); setAvailabilityError(null); }
    }).catch(error => { if (!controller.signal.aborted) setAvailabilityError(error.message); });
    return () => controller.abort();
  }, [openId, date, doctorId, serviceId, duration, refreshReview]);
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000);
    const poll = setInterval(() => { void load(false); }, REFRESH_MS);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [load]);

  useEffect(() => {
    if (!caseId && review?.cases.length === 1 && catalog?.services.find(row => row.id === Number(serviceId))?.followUp) {
      setCaseId(String(review.cases[0].id));
      setDoctorId(String(review.cases[0].doctorId ?? ""));
    }
  }, [review, serviceId, caseId, catalog]);

  const openConfirm = useCallback((request: BookingRequest) => {
    setOpenId(request.id);
    setConfirmed(null);
    setError(null);
    setDate(request.preferredDate ?? catalog?.today ?? "");
    setTime(request.preferences?.time ?? "");
    setServiceId(String(request.preferences?.serviceId ?? ""));
    setDoctorId(String(request.preferences?.doctorId ?? ""));
    setPatientId(""); setCaseId(""); setReview(null);
    setDuration(catalog?.services.find(row => row.id === request.preferences?.serviceId)?.durationMinutes ?? 30);
  }, [catalog]);

  const confirm = useCallback(async (request: BookingRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch(`/api/booking-requests/${request.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", date, time, durationMinutes: duration, serviceId: Number(serviceId), doctorId: Number(doctorId), patientId: patientId ? Number(patientId) : review?.patientId, caseId: caseId ? Number(caseId) : null }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        // اقتراح وقت بديل بدل رفض مجرّد: الاستقبال تقول للمريض وقتًا في نفس المكالمة.
        setError([payload?.message, payload?.suggestionMessage].filter(Boolean).join(" ") || "تعذّر التأكيد.");
        if (typeof payload?.suggestion === "string") setTime(payload.suggestion);
        return;
      }
      if (payload?.status !== "booked" || !payload.scheduledDate || !payload.scheduledTime) {
        setError("الطلب مؤكد سلفًا لكن حالة الموعد تغيّرت. راجع الموعد قبل إبلاغ المريض.");
        await load(false, true); return;
      }
      const number = toWhatsAppNumber(request.phone);
      const text = confirmationText({
        patientName: request.fullName,
        whenText: `${friendlyDate(payload.scheduledDate)} الساعة ${friendlyTime(payload.scheduledTime)}`,
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
  }, [date, time, duration, serviceId, doctorId, patientId, caseId, review, load, CLINIC_NAME, clinicPhone]);

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
                  <div className="mb-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-bold">الخدمة
                      <select aria-label="خدمة الموعد" className="mt-1 w-full rounded-xl border p-2" value={serviceId} disabled={busy}
                        onChange={event => { setServiceId(event.target.value); setDuration(catalog?.services.find(row => row.id === Number(event.target.value))?.durationMinutes ?? 30); }}>
                        <option value="">اختر الخدمة</option>{catalog?.services.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
                      </select></label>
                    <label className="text-sm font-bold">الطبيب
                      <select aria-label="طبيب الموعد" className="mt-1 w-full rounded-xl border p-2" value={doctorId} disabled={busy || Boolean(caseId)} onChange={event => setDoctorId(event.target.value)}>
                        <option value="">اختر الطبيب</option>{catalog?.doctors.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
                      </select></label>
                  </div>
                  {reviewLoading ? <p role="status">جارٍ مراجعة الملف والمواعيد…</p> : review && <div className="mb-3 space-y-3">
                    {review.candidates.length > 1 && <label className="block text-sm font-bold">ملف المريض — تحقق من الهوية
                      <select aria-label="ملف المريض" className="mt-1 w-full rounded-xl border p-2" value={patientId} onChange={event => { setPatientId(event.target.value); setCaseId(""); }}>
                        <option value="">اختر الملف الصحيح</option>{review.candidates.map(row => <option value={row.id} key={row.id}>{row.fullName} — {row.patientNumber}</option>)}
                      </select></label>}
                    {!!review.cases.length && <label className="block text-sm font-bold">الحالة للمراجعة أو العودة
                      <select aria-label="حالة المتابعة" className="mt-1 w-full rounded-xl border p-2" value={caseId} disabled={busy} onChange={event => {
                        setCaseId(event.target.value); const selected = review.cases.find(row => row.id === Number(event.target.value));
                        if (selected) setDoctorId(String(selected.doctorId ?? ""));
                      }}><option value="">اختر الحالة عند المتابعة</option>{review.cases.map(row => <option key={row.id} value={row.id}>{row.title} — {row.doctorName ?? "المسؤول يحتاج مراجعة"}</option>)}</select>
                      {caseId && <p className="mt-1 text-xs text-slate-500">طبيب الموعد من المسؤول المعتمد للحالة. لا يتغير مسؤول الحالة من هنا.</p>}
                    </label>}
                    {!!review.nearby.length && <div role="status" className="rounded-xl bg-amber-50 p-3 text-sm">
                      <p className="font-bold">تنبيه: للمريض مواعيد في اليوم المختار أو خلال يومين منه. تحقق من الحاجة قبل التأكيد.</p>
                      {review.nearby.map(row => <p key={row.id}>{friendlyDate(row.date)} — {friendlyTime(row.time)}</p>)}
                    </div>}
                  </div>}
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
                  <div className="mt-3 text-sm">
                    {availabilityError ? <p role="alert">{availabilityError}</p> : <p>الأوقات المقترحة حسب جدول الطبيب:</p>}
                    <div className="mt-2 flex flex-wrap gap-2">{availableTimes.map(value => <button type="button" key={value} disabled={busy} aria-pressed={time === value} onClick={() => setTime(value)} className="min-h-11 rounded-lg border bg-white px-3">{value}</button>)}</div>
                    <button type="button" className="min-h-11 font-bold text-brand-blue underline" disabled={busy} onClick={() => setRefreshReview(value => value + 1)}>تحديث مراجعة الطلب والأوقات</button>
                  </div>
                  <button
                    onClick={() => confirm(request)}
                    disabled={busy || reviewLoading || !review || !serviceId || !doctorId || !time || (review.candidates.length > 1 && !patientId)}
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
