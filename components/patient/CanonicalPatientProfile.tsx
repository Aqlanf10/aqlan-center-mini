"use client";

import { useEffect, useState } from "react";
import { GENDER_LABEL, ageFromBirthDate, ageFromBirthYear, ageText, type Gender } from "@/lib/patient";
import { STATUS_LABEL } from "@/lib/appointment-lifecycle";
import type { Visit, VisitStatus } from "@/lib/flow";
import { clinicDateString, type Appointment } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";

/**
 * ملف المريض في جلسة الهوية الموحّدة (M2).
 *
 * يعرض ما أسقطه الخادم فقط من قراءةٍ واحدة لملف المريض: الهوية والتواصل لكل من
 * يدخل الملف، والملخّص العلاجي والزيارات لمن يملك صلاحية علاجية، والمواعيد بحسب نطاق
 * المواعيد. بقية أقسام الملف تظهر هنا حين تُنقل مساراتها، ولا تُستدعى قبل ذلك.
 */
interface CorePatient {
  id: number; patientNumber: string; fullName: string; phone: string | null; altPhone: string | null;
  gender: Gender; birthYear: number | null; birthDate: string | null; address: string | null;
  guardianName: string | null; guardianPhone: string | null; nationalId: string | null; email: string | null;
  preferredChannel: string | null; flags: string[] | null; createdAt: string;
  medicalAlert?: string | null; note?: string | null; referralSource?: string | null; referredBy?: string | null;
}
interface PatientFileView {
  patient: CorePatient;
  visits?: Visit[];
  appointments?: Appointment[];
  projection: { care: boolean; balances: boolean; appointments: "none" | "own" | "all" };
}

const VISIT_STATUS_LABEL: Record<VisitStatus, string> = { waiting: "في الانتظار", called: "نُودي", in_chair: "على الكرسي", done: "انتهت" };
const CHANNEL_LABEL: Record<string, string> = { whatsapp: "واتساب", sms: "رسالة نصية", email: "بريد", call: "اتصال" };

export function CanonicalPatientProfile({ patientId }: { patientId: string }) {
  const [file, setFile] = useState<PatientFileView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/patients/${encodeURIComponent(patientId)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) { setError(payload?.message ?? "تعذّر تحميل ملف المريض."); return; }
        setFile(payload as PatientFileView);
      } catch {
        if (!cancelled) setError("تعذّر الاتصال بالخادم.");
      }
    })();
    return () => { cancelled = true; };
  }, [patientId]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl space-y-3">
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        <a href="/patients" className="inline-flex min-h-11 items-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-navy-800">العودة إلى المرضى</a>
      </main>
    );
  }
  if (!file) return <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">جارٍ تحميل الملف…</p>;

  const { patient, projection } = file;
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const age = patient.birthDate ? ageFromBirthDate(patient.birthDate, today) : ageFromBirthYear(patient.birthYear, today);
  return (
    <main className="mx-auto max-w-3xl space-y-4" data-testid="canonical-patient-profile">
      <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold leading-tight text-navy-900 [overflow-wrap:anywhere]">{patient.fullName}</h1>
            <p className="mt-1 text-xs font-semibold text-slate-600">
              {GENDER_LABEL[patient.gender] ?? ""}{age != null ? ` • ${ageText(age)}` : ""}
            </p>
          </div>
          <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs font-bold text-slate-600">{patient.patientNumber}</span>
        </div>
        {patient.medicalAlert ? (
          <p role="note" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-700">⚠ {patient.medicalAlert}</p>
        ) : null}
        {patient.flags?.length ? (
          <p className="mt-2 flex flex-wrap gap-1.5">
            {patient.flags.map(flag => <span key={flag} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-bold text-slate-700">🏷️ {flag}</span>)}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {patient.phone ? <a href={`tel:${patient.phone}`} dir="ltr" className="inline-flex min-h-11 items-center rounded-xl border border-slate-200 px-3 text-sm font-bold text-navy-800">{patient.phone}</a>
            : <span className="text-xs font-semibold text-amber-700">بلا رقم جوال — لا يمكن تذكيره</span>}
          {patient.altPhone ? <a href={`tel:${patient.altPhone}`} dir="ltr" className="inline-flex min-h-11 items-center rounded-xl border border-slate-200 px-3 text-sm font-bold text-navy-800">{patient.altPhone}</a> : null}
        </div>
      </header>

      <section aria-labelledby="canonical-patient-details" className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 id="canonical-patient-details" className="mb-2 text-sm font-bold text-navy-900">البيانات الأساسية</h2>
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <Detail label="العنوان" value={patient.address} />
          <Detail label="وليّ الأمر" value={[patient.guardianName, patient.guardianPhone].filter(Boolean).join(" — ") || null} />
          <Detail label="رقم الهوية" value={patient.nationalId} />
          <Detail label="البريد" value={patient.email} ltr />
          <Detail label="قناة التواصل المفضّلة" value={patient.preferredChannel ? CHANNEL_LABEL[patient.preferredChannel] ?? patient.preferredChannel : null} />
          {projection.care ? <Detail label="مصدر الإحالة" value={[patient.referralSource, patient.referredBy].filter(Boolean).join(" — ") || null} /> : null}
          {projection.care ? <Detail label="ملاحظة" value={patient.note ?? null} /> : null}
        </dl>
      </section>

      {file.visits ? (
        <section aria-labelledby="canonical-patient-visits" className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 id="canonical-patient-visits" className="mb-2 text-sm font-bold text-navy-900">الزيارات الأخيرة</h2>
          {file.visits.length === 0 ? <p className="text-sm text-slate-500">لا زيارات مسجّلة.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {file.visits.map(visit => (
                <li key={visit.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-semibold text-slate-700">{new Date(visit.arrivedAt).toLocaleString("ar-YE-u-nu-latn", { dateStyle: "medium", timeStyle: "short" })}</span>
                  <span className="rounded-lg bg-slate-50 px-2 py-0.5 text-xs font-bold text-slate-600">{VISIT_STATUS_LABEL[visit.status] ?? visit.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {file.appointments ? (
        <section aria-labelledby="canonical-patient-appointments" className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 id="canonical-patient-appointments" className="mb-2 text-sm font-bold text-navy-900">
            المواعيد{projection.appointments === "own" ? " (مواعيدك مع المريض)" : ""}
          </h2>
          {file.appointments.length === 0 ? <p className="text-sm text-slate-500">لا مواعيد.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {file.appointments.map(appointment => (
                <li key={appointment.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-semibold text-slate-700 ltr-nums">{appointment.scheduledDate} {appointment.scheduledTime}</span>
                  <span className="text-xs text-slate-600">{appointment.doctorName ?? ""}</span>
                  <span className="rounded-lg bg-slate-50 px-2 py-0.5 text-xs font-bold text-slate-600">{STATUS_LABEL[appointment.status] ?? appointment.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <p className="text-xs text-slate-600">بقية أقسام الملف (التقويم والخطط والحساب والمستندات وغيرها) تظهر هنا حين تُنقل إلى الهوية الموحّدة.</p>
      <a href="/patients" className="inline-flex min-h-11 items-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-bold text-navy-800">العودة إلى المرضى</a>
    </main>
  );
}

function Detail({ label, value, ltr }: { label: string; value: string | null; ltr?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-slate-500">{label}</dt>
      <dd className="font-semibold text-slate-800 [overflow-wrap:anywhere]" dir={ltr ? "ltr" : undefined}>{value || "—"}</dd>
    </div>
  );
}
