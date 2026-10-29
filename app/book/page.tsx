"use client";

import { useEffect, useRef, useState } from "react";
import { useClinicName, useSetting } from "@/components/SettingsProvider";
import { Logo } from "@/components/Icon";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import type { publicBookingCatalog } from "@/lib/public-booking";

type Catalog = Awaited<ReturnType<typeof publicBookingCatalog>>;
const inputClass = "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none focus:border-brand-blue";
const buttonClass = "min-h-11 rounded-xl bg-accent-500 px-5 py-3 font-bold text-white disabled:opacity-40";
const labelFor = (date: string) => new Intl.DateTimeFormat("ar-YE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

export default function BookPage() {
  const clinicName = useClinicName();
  const doctor = useSetting("clinic.lead_doctor");
  const doctorTitle = useSetting("clinic.lead_doctor_title");
  const clinicPhone = useSetting("clinic.phone");
  const clinicAddress = useSetting("clinic.address");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [serviceId, setServiceId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [preferredDate, setPreferredDate] = useState("");
  const [time, setTime] = useState("");
  const [times, setTimes] = useState<string[]>([]);
  const [loadingTimes, setLoadingTimes] = useState(false);
  const [timesError, setTimesError] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [website, setWebsite] = useState("");
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const inFlight = useRef(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/book", { cache: "no-store", signal: abort.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message);
      setCatalog(payload); setCatalogError(null);
    }).catch(error => { if (!abort.signal.aborted) setCatalogError(error.message || "تعذّر تحميل الاختيارات."); });
    return () => abort.abort();
  }, [reload]);

  useEffect(() => {
    if (!serviceId || !doctorId || !preferredDate) return;
    const abort = new AbortController();
    setLoadingTimes(true); setTimesError(null); setTimes([]); setTime("");
    const query = new URLSearchParams({ serviceId, doctorId, date: preferredDate });
    fetch(`/api/book?${query}`, { cache: "no-store", signal: abort.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message);
      if (!abort.signal.aborted) setTimes(payload.times);
    }).catch(error => { if (!abort.signal.aborted) setTimesError(error.message || "تعذّر تحميل الأوقات."); })
      .finally(() => { if (!abort.signal.aborted) setLoadingTimes(false); });
    return () => abort.abort();
  }, [serviceId, doctorId, preferredDate, reload]);

  useEffect(() => { heading.current?.focus(); }, [step, sent]);
  const selectionChanged = () => { setTime(""); setTimes([]); setError(null); };
  const service = catalog?.services.find(row => row.id === Number(serviceId));
  const selectedDoctor = catalog?.doctors.find(row => row.id === Number(doctorId));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (step < 3) { setStep(step + 1); return; }
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const body = JSON.stringify({ fullName, phone, reason, preferredDate, preferredPeriod: "any", website,
        preferences: { serviceId: Number(serviceId), doctorId: Number(doctorId), time } });
      if (attempt.current?.body !== body) {
        let key = newIdempotencyKey("book");
        // Store only a digest and random key; never patient names, phones or reasons.
        if (globalThis.crypto?.subtle) {
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))), byte => byte.toString(16).padStart(2, "0")).join("");
          try {
            const saved = JSON.parse(sessionStorage.getItem("aqlan-book-attempt") ?? "null");
            if (saved?.digest === digest && typeof saved.key === "string") key = saved.key;
            sessionStorage.setItem("aqlan-book-attempt", JSON.stringify({ digest, key }));
          } catch { /* In-memory replay still works when storage is unavailable. */ }
        }
        attempt.current = { body, key };
      }
      const response = await fetch("/api/book", { method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key }, body });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.received !== true) {
        // A rejected retry (including 429) says nothing about an earlier lost
        // response. Keep that attempt locked until its receipt is confirmed.
        setUncertain(previous => previous || response.status >= 500 || response.ok);
        setError(payload?.message ?? "تعذّر التحقق من وصول الطلب. أعد الإرسال للتحقق بالمحاولة نفسها.");
        return;
      }
      setUncertain(false); setSent(true);
    } catch {
      setUncertain(true);
      setError("انقطع الاتصال ولم نتأكد من وصول الطلب. أعد الإرسال للتحقق؛ لن يتكرر طلبك.");
    } finally { inFlight.current = false; setBusy(false); }
  };

  return <main dir="rtl" className="mx-auto max-w-lg p-4 pb-16">
    <header className="mb-5 mt-4 text-center">
      <Logo className="mx-auto h-14 w-14" />
      <p className="mt-3 text-base font-bold leading-snug text-navy-900">{clinicName}</p>
      <p className="mt-1 text-xs font-semibold text-slate-500">{doctor}{doctorTitle ? ` — ${doctorTitle}` : ""}</p>
      <h1 ref={heading} tabIndex={-1} className="mt-4 text-xl font-bold text-navy-900 outline-none">{sent ? "وصلنا طلبكم" : "طلب موعد"}</h1>
    </header>
    {sent ? <section className="rounded-3xl border border-success-300 bg-white p-6 text-center">
      <p className="font-bold text-success-700">تم استلام طلب الموعد</p>
      <p className="mt-3 leading-relaxed">سنتصل بكم لتأكيد الوقت. الموعد غير مؤكد حتى نتواصل معكم.</p>
      <p className="mt-4 text-sm">{service?.name} — {selectedDoctor?.name}</p>
      <p className="mt-2 text-sm">{labelFor(preferredDate)}، الساعة <span dir="ltr">{time}</span> بتوقيت المركز</p>
      <p className="mt-4 text-sm text-slate-500">لتغيير الطلب أو إلغائه تواصلوا مع الاستقبال.</p>
    </section> : <form onSubmit={submit} className="rounded-3xl border border-slate-200 bg-white p-5">
      <ol aria-label="خطوات طلب الموعد" className="mb-5 flex justify-between gap-2 text-xs font-bold">
        {["الموعد", "بيانات التواصل", "المراجعة"].map((label, index) => <li key={label} aria-current={step === index + 1 ? "step" : undefined}
          className={step === index + 1 ? "text-brand-blue" : "text-slate-500"}>{index + 1}. {label}</li>)}
      </ol>
      {step === 1 && <div className="space-y-4">
        <p className="text-sm text-slate-600">اختر الخدمة والطبيب ثم الوقت المناسب. الأوقات مقترحة ويؤكدها الاستقبال بعد المراجعة.</p>
        {catalogError ? <div role="alert"><p>{catalogError}</p><button type="button" className={buttonClass} onClick={() => setReload(value => value + 1)}>إعادة التحميل</button></div>
          : !catalog ? <p role="status">جارٍ تحميل الاختيارات…</p> : <>
            <label className="block text-sm font-bold">الخدمة<select required className={inputClass} value={serviceId} onChange={event => { setServiceId(event.target.value); selectionChanged(); }}>
              <option value="">اختر الخدمة</option>{catalog.services.map(row => <option key={row.id} value={row.id}>{row.name} — {row.durationMinutes} دقيقة</option>)}</select></label>
            <label className="block text-sm font-bold">الطبيب<select required className={inputClass} value={doctorId} onChange={event => { setDoctorId(event.target.value); selectionChanged(); }}>
              <option value="">اختر الطبيب</option>{catalog.doctors.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
            <p className="text-xs text-slate-500">للمراجعة أو العودة: يراجع الاستقبال الطبيب المسؤول عن الحالة قبل التأكيد.</p>
            <label className="block text-sm font-bold">اليوم<select required className={inputClass} value={preferredDate} onChange={event => { setPreferredDate(event.target.value); selectionChanged(); }}>
              <option value="">اختر اليوم</option>{catalog.days.map(day => <option key={day} value={day}>{labelFor(day)}</option>)}</select></label>
            {!catalog.days.length && <p role="status">لا توجد أيام متاحة حاليًا. تواصلوا مع المركز.</p>}
            {serviceId && doctorId && preferredDate && <div aria-live="polite">
              <p className="text-sm font-bold">الوقت — بتوقيت المركز ({catalog.timeZone})</p>
              {loadingTimes ? <p role="status" className="py-4">جارٍ التحقق من الأوقات…</p> : timesError ? <p role="alert" className="py-3 text-red-700">{timesError}</p>
                : times.length ? <div className="mt-2 grid grid-cols-3 gap-2">{times.map(value => <button key={value} type="button" aria-pressed={time === value}
                  onClick={() => setTime(value)} className={`min-h-11 rounded-xl border p-2 font-bold ${time === value ? "border-brand-blue bg-brand-blue text-white" : "border-slate-300"}`}><span dir="ltr">{value}</span></button>)}</div>
                  : <p className="py-3 text-sm">لا توجد أوقات متاحة لهذا الطبيب في اليوم المختار. اختر يومًا آخر أو تواصل مع المركز.</p>}
              <button type="button" disabled={loadingTimes} className="mt-3 min-h-11 text-sm font-bold text-brand-blue underline" onClick={() => setReload(value => value + 1)}>تحديث الأوقات</button>
            </div>}
          </>}
      </div>}
      {step === 2 && <div className="space-y-4">
        <label className="block text-sm font-bold">الاسم الكامل<input required minLength={3} maxLength={60} className={inputClass} autoComplete="name" value={fullName} onChange={event => setFullName(event.target.value)} /></label>
        <label className="block text-sm font-bold">رقم الجوال<input required type="tel" dir="ltr" inputMode="tel" autoComplete="tel" className={inputClass} placeholder="7XXXXXXXX" value={phone} onChange={event => setPhone(event.target.value)} /></label>
        <p className="text-xs text-slate-500">سنتصل بهذا الرقم لتأكيد الموعد.</p>
        <label className="block text-sm font-bold">سبب الزيارة (اختياري)<textarea rows={3} maxLength={200} className={inputClass} value={reason} onChange={event => setReason(event.target.value)} /></label>
      </div>}
      {step === 3 && <div className="space-y-3 text-sm">
        <h2 className="font-bold">راجع طلبك قبل الإرسال</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 rounded-xl bg-slate-50 p-4">
          <dt>الخدمة</dt><dd>{service?.name}</dd><dt>الطبيب</dt><dd>{selectedDoctor?.name}</dd>
          <dt>اليوم</dt><dd>{labelFor(preferredDate)}</dd><dt>الوقت</dt><dd><span dir="ltr">{time}</span> — بتوقيت المركز</dd>
          <dt>المدة</dt><dd>{service?.durationMinutes} دقيقة</dd><dt>الاسم</dt><dd>{fullName}</dd><dt>الجوال</dt><dd dir="ltr" className="text-right">{phone}</dd>
        </dl>
        <p>هذا طلب موعد. سنراجع التوافر والحالة ونتصل بكم لتأكيده.</p>
      </div>}
      <input name="website" value={website} onChange={event => setWebsite(event.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="pointer-events-none absolute h-0 w-0 opacity-0" />
      {error && <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex gap-3">
        {step > 1 && <button type="button" disabled={busy || uncertain} className="min-h-11 rounded-xl border border-slate-300 px-5 py-3 font-bold disabled:opacity-40" onClick={() => { setStep(step - 1); setError(null); }}>رجوع</button>}
        <button type="submit" disabled={busy || (step === 1 && (!time || loadingTimes))} className={`${buttonClass} flex-1`}>
          {busy ? "جارٍ الإرسال…" : step < 3 ? "متابعة" : uncertain ? "إعادة الإرسال للتحقق" : "أرسل طلب الموعد"}</button>
      </div>
      <p className="mt-4 text-center text-xs leading-relaxed text-slate-500">لديكم ملف لدينا؟ <a href="/portal" className="font-bold text-navy-800 underline">ادخلوا بوابة المريض</a> لعرض مواعيدكم وتأكيد الحضور.</p>
    </form>}
    <footer className="mt-5 text-center text-xs leading-relaxed text-slate-500">
      {clinicAddress && <p>{clinicAddress}</p>}{clinicPhone && <p className="mt-2">للتواصل والتعديل والإلغاء: <a href={`tel:${clinicPhone}`} dir="ltr" className="font-bold text-navy-800">{clinicPhone}</a></p>}
    </footer>
  </main>;
}
