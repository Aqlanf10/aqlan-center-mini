"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import type { Visit } from "@/lib/flow";
import type { Appointment } from "@/lib/schedule";
import { GENDER_LABEL, ageFromBirthYear, ageText, type Gender, type Patient } from "@/lib/patient";
import { friendlyDate, friendlyDateLong, friendlyTime, toWhatsAppNumber } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PatientLedger } from "@/components/PatientLedger";
import { PatientPlans } from "@/components/PatientPlans";
import { shortMinutes } from "@/lib/report";
import { DentalChart } from "@/components/DentalChart";

/**
 * ملف المريض.
 *
 * كل ما تحتاجه الاستقبال أن تعرفه عن مريض واقف أمامها، في شاشة واحدة. وأول ما يجب
 * أن تراه العين هو **التنبيه الطبي**: حساسية بنج أو مميعات دم تُقرأ قبل الإجراء لا
 * بعده، فهي فوق كل شيء وبلون لا يُخطئه أحد.
 */

interface PatientFile {
  patient: Patient;
  visits: Visit[];
  appointments: Appointment[];
}

const STATUS_LABEL: Record<string, string> = {
  booked: "محجوز", arrived: "وصل", done: "تم", cancelled: "ملغى", no_show: "لم يحضر",
};

function dateOnly(iso: string): string {
  const parsed = new Date(iso);
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

type Tab = "overview" | "chart" | "plans" | "ledger" | "appointments" | "visits";

export default function PatientFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const today = useMemo(() => clinicDateString(new Date(), "Asia/Aden"), []);
  const [file, setFile] = useState<PatientFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/patients/${id}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setFile(payload as PatientFile);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const upcoming = useMemo(() => {
    if (!file) return null;
    return [...file.appointments]
      .filter((a) => a.scheduledDate >= today && (a.status === "booked" || a.status === "arrived"))
      .sort((a, b) => (a.scheduledDate + a.scheduledTime).localeCompare(b.scheduledDate + b.scheduledTime))[0] ?? null;
  }, [file, today]);

  if (loading && !file) {
    return <main className="mx-auto max-w-3xl p-4"><p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p></main>;
  }
  if (!file) {
    return (
      <main className="mx-auto max-w-3xl p-4">
        <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">{error ?? "لا يوجد مريض بهذا الرقم."}</p>
        <a href="/patients" className="mt-4 block text-center text-sm font-bold text-brand-blue">العودة للبحث</a>
      </main>
    );
  }

  const patient = file.patient;
  const whatsApp = toWhatsAppNumber(patient.phone);
  const lastVisit = file.visits[0] ?? null;
  const age = ageFromBirthYear(patient.birthYear, today);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <header className="mb-4">
        <h1 className="text-xl font-extrabold leading-tight">{patient.fullName}</h1>
        <p className="text-xs text-slate-500">
          {patient.patientNumber} · {GENDER_LABEL[patient.gender]} · {ageText(age)}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <a href="/patients" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">‹ كل المرضى</a>
          {whatsApp ? (
            <a href={`https://wa.me/${whatsApp}`} target="_blank" rel="noopener"
              className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white">واتساب</a>
          ) : null}
          <button onClick={() => setEditing((open) => !open)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">
            {editing ? "إغلاق التعديل" : "تعديل البيانات"}
          </button>
        </div>
      </header>

      {/* التنبيه الطبي فوق كل شيء: يُقرأ قبل الإجراء لا بعده. */}
      {patient.medicalAlert ? (
        <p className="mb-4 rounded-2xl border-2 border-red-400 bg-red-50 px-4 py-3 text-sm font-extrabold text-red-700">
          ⚠ {patient.medicalAlert}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {editing ? (
        <PatientEditor
          patient={patient}
          onSaved={() => { setEditing(false); void load(); }}
          onError={setError}
        />
      ) : null}

      <section className="mb-4 grid grid-cols-2 gap-2" aria-label="ملخص">
        <div className="rounded-2xl border border-slate-200 bg-white p-3 text-center">
          <p className="text-sm font-extrabold">
            {lastVisit ? friendlyDate(dateOnly(lastVisit.arrivedAt)) : "لا توجد"}
          </p>
          <p className="text-[11px] font-bold text-slate-500">آخر زيارة</p>
        </div>
        <div className={`rounded-2xl border p-3 text-center ${upcoming ? "border-brand-blue bg-white" : "border-amber-300 bg-amber-50"}`}>
          <p className="text-sm font-extrabold">
            {upcoming ? `${friendlyDate(upcoming.scheduledDate)} · ${friendlyTime(upcoming.scheduledTime)}` : "لا يوجد موعد قادم"}
          </p>
          <p className="text-[11px] font-bold text-slate-500">الموعد القادم</p>
        </div>
      </section>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {([["overview", "نظرة عامة"], ["chart", "المخطط السني"], ["plans", "خطة العلاج"], ["ledger", "الحساب"], ["appointments", `المواعيد (${file.appointments.length})`], ["visits", `الزيارات (${file.visits.length})`]] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-xl border px-3 py-1.5 text-xs font-bold ${
              tab === key ? "border-navy-800 bg-navy-800 text-white" : "border-slate-200 bg-white text-slate-600"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="البيانات">
          <Row label="رقم الجوال" value={patient.phone} ltr />
          <Row label="رقم بديل" value={patient.altPhone} ltr />
          <Row label="سنة الميلاد" value={patient.birthYear ? String(patient.birthYear) : null} ltr />
          <Row label="العنوان" value={patient.address} />
          <Row label="مسجّل منذ" value={friendlyDateLong(dateOnly(patient.createdAt))} />
          <Row label="ملاحظة" value={patient.note} />
        </section>
      ) : tab === "chart" ? (
        <DentalChart patientId={file.patient.id} />
      ) : tab === "plans" ? (
        <PatientPlans patientId={patient.id} />
      ) : tab === "ledger" ? (
        <PatientLedger patientId={patient.id} />
      ) : tab === "appointments" ? (
        file.appointments.length === 0 ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">لا توجد مواعيد.</p>
        ) : (
          <ul className="space-y-2">
            {file.appointments.map((appointment) => (
              <li key={appointment.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3">
                <span className="text-sm font-bold">
                  {friendlyDateLong(appointment.scheduledDate)} · {friendlyTime(appointment.scheduledTime)}
                </span>
                <span className="text-xs text-slate-500">
                  {shortMinutes(appointment.durationMinutes)} · {STATUS_LABEL[appointment.status] ?? appointment.status}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : file.visits.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400">
          لا توجد زيارات مسجّلة بهذا السجل.
        </p>
      ) : (
        <ul className="space-y-2">
          {file.visits.map((visit) => (
            <li key={visit.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3">
              <span className="text-sm font-bold">{friendlyDateLong(dateOnly(visit.arrivedAt))}</span>
              <span className="text-xs text-slate-500">
                {visit.status === "done" ? "اكتملت" : "لم تكتمل"}
                {visit.chair ? ` · كرسي ${visit.chair}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Row({ label, value, ltr = false }: { label: string; value: string | null; ltr?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 py-2 last:border-b-0">
      <span className="shrink-0 text-xs font-bold text-slate-500">{label}</span>
      <span className={`text-sm ${value ? "font-bold" : "text-slate-300"}`} dir={ltr ? "ltr" : undefined}>
        {value || "—"}
      </span>
    </div>
  );
}

function PatientEditor({ patient, onSaved, onError }: {
  patient: Patient;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const [form, setForm] = useState({
    fullName: patient.fullName,
    phone: patient.phone ?? "",
    altPhone: patient.altPhone ?? "",
    gender: patient.gender,
    birthYear: patient.birthYear ? String(patient.birthYear) : "",
    address: patient.address ?? "",
    medicalAlert: patient.medicalAlert ?? "",
    note: patient.note ?? "",
  });
  const [saving, setSaving] = useState(false);

  const set = (key: keyof typeof form, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    onError(null);
    try {
      const response = await fetch(`/api/patients/${patient.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { onError(payload?.message ?? "تعذّر الحفظ."); return; }
      onSaved();
    } catch {
      onError("تعذّر الاتصال بالخادم.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-4 rounded-2xl border border-brand-blue bg-white p-4" aria-label="تعديل البيانات">
      <h2 className="mb-3 text-sm font-bold">تعديل بيانات المريض</h2>

      <Field label="الاسم الكامل">
        <input value={form.fullName} onChange={(e) => set("fullName", e.target.value)} className={inputClass} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Field label="رقم الجوال" className="min-w-[9rem] flex-1">
          <input value={form.phone} onChange={(e) => set("phone", e.target.value)} dir="ltr" inputMode="tel" className={inputClass} />
        </Field>
        <Field label="رقم بديل" className="min-w-[9rem] flex-1">
          <input value={form.altPhone} onChange={(e) => set("altPhone", e.target.value)} dir="ltr" inputMode="tel" className={inputClass} />
        </Field>
        <Field label="سنة الميلاد" className="w-28">
          <input value={form.birthYear} onChange={(e) => set("birthYear", e.target.value)} dir="ltr" inputMode="numeric" className={inputClass} />
        </Field>
      </div>

      <Field label="الجنس">
        <div className="flex gap-2">
          {(["male", "female", "unknown"] as Gender[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => set("gender", option)}
              className={`flex-1 rounded-xl border px-3 py-2 text-sm font-bold ${
                form.gender === option ? "border-brand-blue bg-brand-blue text-white" : "border-slate-200 bg-white text-slate-600"
              }`}
            >
              {GENDER_LABEL[option]}
            </button>
          ))}
        </div>
      </Field>

      <Field label="العنوان">
        <input value={form.address} onChange={(e) => set("address", e.target.value)} className={inputClass} />
      </Field>

      <Field label="تنبيه طبي" hint="يظهر بالأحمر فوق الملف وفي قائمة البحث">
        <input value={form.medicalAlert} onChange={(e) => set("medicalAlert", e.target.value)} className={inputClass} />
      </Field>

      <Field label="ملاحظة دائمة" hint="تُقرأ في كل زيارة — «يفضّل آخر الدوام»، «يخاف الإبرة»">
        <textarea value={form.note} onChange={(e) => set("note", e.target.value)} rows={3} maxLength={2000}
          className={`${inputClass} resize-none`} />
      </Field>

      <button
        onClick={save}
        disabled={saving}
        className="w-full rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50"
      >
        {saving ? "جارٍ الحفظ…" : "حفظ التعديلات"}
      </button>
    </section>
  );
}

const inputClass = "w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue";

function Field({ label, hint, className = "", children }: {
  label: string; hint?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <label className={`mb-3 block ${className}`}>
      <span className="mb-1 block text-[11px] font-bold text-slate-500">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-slate-400">{hint}</span> : null}
    </label>
  );
}
