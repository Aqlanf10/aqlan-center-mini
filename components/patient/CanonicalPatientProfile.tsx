"use client";

import { useEffect, useState } from "react";
import { GENDER_LABEL, ageFromBirthDate, ageFromBirthYear, ageText, type Gender } from "@/lib/patient";
import { STATUS_LABEL } from "@/lib/appointment-lifecycle";
import type { Visit, VisitStatus } from "@/lib/flow";
import { clinicDateString, type Appointment } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { PROBLEM_STATUS_LABEL, type ProblemStatus } from "@/lib/cases";
import { TIMELINE_KIND_LABEL, type TimelineKind } from "@/lib/workflow";
import { REFERRAL_SPECIALTY_LABEL, REFERRAL_STATUS_LABEL, type ReferralSpecialty, type ReferralStatus } from "@/lib/referrals";
import { CONSENT_CHANNEL_LABEL, type ConsentChannel, type ConsentState } from "@/lib/patient-identity";

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
  /** الملخص التشغيلي: وجود تنبيه طبي دون نصه، ووجود حالة تقويم نشطة. */
  hasMedicalAlert?: boolean; activeOrtho?: boolean;
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
        ) : patient.hasMedicalAlert ? (
          <p role="note" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800">⚠ يوجد تنبيه طبي — نسّق مع الطبيب قبل الحجز</p>
        ) : null}
        {patient.activeOrtho ? (
          <p className="mt-2 inline-block rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-bold text-indigo-700">حالة تقويم نشطة</p>
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

      <ContactConsentPanel patientId={patientId} />
      {projection.care ? <ClinicalPanels patientId={patientId} /> : null}
      <TimelinePanel patientId={patientId} />

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

/** قراءةٌ واحدة لقسمٍ من الملف عبر مساره الموحّد؛ الخطأ يُعرض نصًّا عربيًّا محدودًا. */
function usePatientSection<T>(url: string | null): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        setState(response.ok ? { data: payload as T, error: null } : { data: null, error: payload?.message ?? "تعذّر التحميل." });
      } catch {
        if (!cancelled) setState({ data: null, error: "تعذّر الاتصال بالخادم." });
      }
    })();
    return () => { cancelled = true; };
  }, [url]);
  return state;
}

interface MedicalHistoryView {
  alerts: { label: string; severity: string }[];
  review: { due: boolean; months: number };
  latest: { recordedAt: string } | null;
  vitals: { id: number; recordedAt: string; bpSystolic: number | null; bpDiastolic: number | null; pulse: number | null; spo2: number | null; glucose: number | null; temperature: number | null }[];
}
interface ProblemView { id: number; label: string; site: string | null; status: ProblemStatus; caseTitle: string | null }

/** الأقسام السريرية: لمن أسقط له الخادم المجموعة العلاجية فقط (المسار يفرضها أيضًا). */
function ClinicalPanels({ patientId }: { patientId: string }) {
  const id = encodeURIComponent(patientId);
  const history = usePatientSection<MedicalHistoryView>(`/api/patients/${id}/medical-history`);
  const problems = usePatientSection<ProblemView[]>(`/api/patients/${id}/problems`);
  const referrals = usePatientSection<ReferralView[]>(`/api/patients/${id}/referrals`);
  const latestVitals = history.data?.vitals[0] ?? null;
  return (
    <>
      <section aria-labelledby="canonical-patient-history" className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 id="canonical-patient-history" className="mb-2 text-sm font-bold text-navy-900">التاريخ الطبي والعلامات الحيوية</h2>
        {history.error ? <p role="alert" className="text-sm text-red-700">{history.error}</p> : !history.data ? <p className="text-sm text-slate-500">جارٍ التحميل…</p> : (
          <div className="space-y-2 text-sm">
            {history.data.alerts.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {history.data.alerts.map(alert => <li key={alert.label} className="rounded-lg border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-bold text-red-700">⚠ {alert.label}</li>)}
              </ul>
            ) : <p className="text-slate-600">لا تنبيهات من آخر تاريخ طبي.</p>}
            {!history.data.latest ? <p className="font-semibold text-amber-800">لم يُسجَّل تاريخ طبي بعد.</p>
              : history.data.review.due ? <p className="font-semibold text-amber-800">التاريخ الطبي يحتاج مراجعة (أقدم من {history.data.review.months} أشهر).</p> : null}
            {latestVitals ? (
              <p className="text-slate-700 ltr-nums" data-testid="canonical-latest-vitals">
                آخر قياس: {latestVitals.bpSystolic != null && latestVitals.bpDiastolic != null ? `الضغط ${latestVitals.bpSystolic}/${latestVitals.bpDiastolic}` : ""}
                {latestVitals.pulse != null ? ` • النبض ${latestVitals.pulse}` : ""}{latestVitals.spo2 != null ? ` • الأكسجين ${latestVitals.spo2}%` : ""}
                {latestVitals.glucose != null ? ` • السكر ${latestVitals.glucose}` : ""}
              </p>
            ) : <p className="text-slate-600">لا علامات حيوية مسجّلة.</p>}
          </div>
        )}
      </section>
      <section aria-labelledby="canonical-patient-problems" className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 id="canonical-patient-problems" className="mb-2 text-sm font-bold text-navy-900">قائمة المشاكل</h2>
        {problems.error ? <p role="alert" className="text-sm text-red-700">{problems.error}</p> : !problems.data ? <p className="text-sm text-slate-500">جارٍ التحميل…</p>
          : problems.data.length === 0 ? <p className="text-sm text-slate-500">لا مشاكل مسجّلة.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {problems.data.map(problem => (
                <li key={problem.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-semibold text-slate-800 [overflow-wrap:anywhere]">{problem.label}{problem.site ? ` — ${problem.site}` : ""}</span>
                  <span className="rounded-lg bg-slate-50 px-2 py-0.5 text-xs font-bold text-slate-600">{PROBLEM_STATUS_LABEL[problem.status] ?? problem.status}</span>
                </li>
              ))}
            </ul>
          )}
      </section>
      <section aria-labelledby="canonical-patient-referrals" className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 id="canonical-patient-referrals" className="mb-2 text-sm font-bold text-navy-900">الإحالات</h2>
        {referrals.error ? <p role="alert" className="text-sm text-red-700">{referrals.error}</p> : !referrals.data ? <p className="text-sm text-slate-500">جارٍ التحميل…</p>
          : referrals.data.length === 0 ? <p className="text-sm text-slate-500">لا إحالات.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {referrals.data.map(referral => (
                <li key={referral.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-semibold text-slate-800 [overflow-wrap:anywhere]">{referral.toName} — {REFERRAL_SPECIALTY_LABEL[referral.toSpecialty] ?? referral.toSpecialty}</span>
                  <span className="rounded-lg bg-slate-50 px-2 py-0.5 text-xs font-bold text-slate-600">{REFERRAL_STATUS_LABEL[referral.status] ?? referral.status}</span>
                </li>
              ))}
            </ul>
          )}
      </section>
    </>
  );
}

interface ReferralView { id: number; toName: string; toSpecialty: ReferralSpecialty; status: ReferralStatus }
interface ConsentView { mode: "opt_in" | "opt_out"; states?: Record<ConsentChannel, ConsentState> }
const CONSENT_STATE_LABEL: Record<ConsentState, string> = { granted: "موافق", withdrawn: "سحب موافقته", unknown: "غير مسجّل" };

/** موافقات التواصل: لكل من يدخل الملف (الهوية والتواصل). التسجيل يتبع مساره عند نقله. */
function ContactConsentPanel({ patientId }: { patientId: string }) {
  const consent = usePatientSection<ConsentView>(`/api/patients/${encodeURIComponent(patientId)}/contact`);
  return (
    <section aria-labelledby="canonical-patient-consent" className="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 id="canonical-patient-consent" className="mb-2 text-sm font-bold text-navy-900">موافقات التواصل</h2>
      {consent.error ? <p role="alert" className="text-sm text-red-700">{consent.error}</p> : !consent.data ? <p className="text-sm text-slate-500">جارٍ التحميل…</p> : (
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {(Object.entries(consent.data.states ?? {}) as [ConsentChannel, ConsentState][]).map(([channel, state]) => (
            <li key={channel} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 font-bold text-slate-700">
              {CONSENT_CHANNEL_LABEL[channel] ?? channel}: {CONSENT_STATE_LABEL[state] ?? state}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface TimelineView { events: { key: string; kind: TimelineKind; at: string; title: string; detail: string | null }[] }

/** الخط الزمني: الخادم يحذف أحداث المجموعات غير المسقطة كليًّا (لا إخفاء مبالغ فقط). */
function TimelinePanel({ patientId }: { patientId: string }) {
  const timeline = usePatientSection<TimelineView>(`/api/patients/${encodeURIComponent(patientId)}/timeline?limit=30`);
  return (
    <section aria-labelledby="canonical-patient-timeline" className="rounded-2xl border border-slate-200 bg-white p-4">
      <h2 id="canonical-patient-timeline" className="mb-2 text-sm font-bold text-navy-900">الخط الزمني</h2>
      {timeline.error ? <p role="alert" className="text-sm text-red-700">{timeline.error}</p> : !timeline.data ? <p className="text-sm text-slate-500">جارٍ التحميل…</p>
        : timeline.data.events.length === 0 ? <p className="text-sm text-slate-500">لا أحداث ضمن ما تملك عرضه.</p> : (
          <ol className="space-y-2 text-sm">
            {timeline.data.events.map(event => (
              <li key={event.key} className="rounded-xl border border-slate-100 px-3 py-2">
                <span className="text-xs font-bold text-slate-500">{TIMELINE_KIND_LABEL[event.kind] ?? event.kind} • {new Date(event.at).toLocaleDateString("ar-YE-u-nu-latn")}</span>
                <span className="block font-semibold text-slate-800 [overflow-wrap:anywhere]">{event.title}</span>
                {event.detail ? <span className="block text-xs text-slate-600 [overflow-wrap:anywhere]">{event.detail}</span> : null}
              </li>
            ))}
          </ol>
        )}
    </section>
  );
}

