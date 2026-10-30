"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CanonicalNextSession } from "./CanonicalNextSession";
import { CanonicalOrthoCases } from "./CanonicalOrthoCases";
import { useSession } from "@/components/SessionProvider";
import { GENDER_LABEL, ageFromBirthDate, ageFromBirthYear, ageText, type Gender } from "@/lib/patient";
import { STATUS_LABEL } from "@/lib/appointment-lifecycle";
import type { Visit, VisitStatus } from "@/lib/flow";
import { clinicDateString, type Appointment } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { PROBLEM_STATUS_LABEL, type ProblemStatus } from "@/lib/cases";
import { TIMELINE_KIND_LABEL, type TimelineKind } from "@/lib/workflow";
import { REFERRAL_SPECIALTY_LABEL, REFERRAL_STATUS_LABEL, type ReferralSpecialty, type ReferralStatus } from "@/lib/referrals";
import { CONSENT_CHANNEL_LABEL, CONSENT_SOURCE_LABEL, MANUAL_CONSENT_SOURCES, type ConsentChannel, type ConsentSource, type ConsentState } from "@/lib/patient-identity";

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
  const session = useSession();
  const canEdit = session?.isOwner === true || (session?.capabilities ?? []).includes("patients.edit");
  const [file, setFile] = useState<PatientFileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

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

      {canEdit && editing ? (
        <PatientEditForm patient={patient} care={projection.care} patientId={patientId}
          onCancel={() => setEditing(false)}
          onSaved={saved => { setFile(current => current ? { ...current, patient: { ...current.patient, ...saved } } : current); setEditing(false); }} />
      ) : null}
      <section aria-labelledby="canonical-patient-details" className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id="canonical-patient-details" className="text-sm font-bold text-navy-900">البيانات الأساسية</h2>
          {canEdit && !editing ? (
            <button type="button" onClick={() => setEditing(true)} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">تعديل البيانات</button>
          ) : null}
        </div>
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
                  <CanonicalNextSession visitId={visit.id} patientId={patient.id} />
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

      <ContactConsentPanel patientId={patientId} canRecord={canEdit} />
      {session?.isOwner === true || (session?.capabilities?.includes("clinical.ortho.view") && (session.patientScope === "own" || session.patientScope === "all"))
        ? <CanonicalOrthoCases key={`${session.username}:${session.patientScope}:${patientId}`} patientId={patientId} /> : null}
      {projection.care ? <ClinicalPanels patientId={patientId} /> : null}
      {projection.care ? <PlannedVisitsPanel patientId={patientId}
        canBook={session?.isOwner === true || (session?.capabilities ?? []).includes("appointments.create")} /> : null}
      <TimelinePanel patientId={patientId} />

      <p className="text-xs text-slate-600">بقية تفاصيل الملف والخطط والحساب والمستندات تظهر هنا حين تُنقل إلى الهوية الموحّدة.</p>
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
function ContactConsentPanel({ patientId, canRecord }: { patientId: string; canRecord: boolean }) {
  const [version, setVersion] = useState(0);
  const consent = usePatientSection<ConsentView>(`/api/patients/${encodeURIComponent(patientId)}/contact?v=${version}`);
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
      {canRecord ? <ConsentRecordForm patientId={patientId} onRecorded={() => setVersion(value => value + 1)} /> : null}
    </section>
  );
}

/** تسجيل موافقة تواصل: صلاحية patients.edit، والخادم يتحقق من النطاق ويدقّق ذرّيًا. */
function ConsentRecordForm({ patientId, onRecorded }: { patientId: string; onRecorded: () => void }) {
  const uid = useId();
  const [channel, setChannel] = useState<ConsentChannel>("whatsapp");
  const [granted, setGranted] = useState(true);
  const [source, setSource] = useState<ConsentSource>("in_person");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/patients/${encodeURIComponent(patientId)}/contact`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel, granted, source }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage({ ok: false, text: payload?.message ?? "تعذّر حفظ الموافقة." }); return; }
      setMessage({ ok: true, text: "سُجّلت الموافقة." });
      onRecorded();
    } catch { setMessage({ ok: false, text: "تعذّر الاتصال بالخادم. لم يُعتبر التسجيل محفوظًا." }); }
    finally { setBusy(false); }
  }
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3" data-testid="consent-record-form">
      <label className="text-xs font-bold text-navy-900" htmlFor={`${uid}-channel`}>القناة
        <select id={`${uid}-channel`} value={channel} onChange={event => setChannel(event.target.value as ConsentChannel)} className="mt-1 block min-h-11 rounded-xl border border-slate-300 px-2 text-sm">
          {(Object.keys(CONSENT_CHANNEL_LABEL) as ConsentChannel[]).map(value => <option key={value} value={value}>{CONSENT_CHANNEL_LABEL[value]}</option>)}
        </select>
      </label>
      <label className="text-xs font-bold text-navy-900" htmlFor={`${uid}-granted`}>الموافقة
        <select id={`${uid}-granted`} value={granted ? "yes" : "no"} onChange={event => setGranted(event.target.value === "yes")} className="mt-1 block min-h-11 rounded-xl border border-slate-300 px-2 text-sm">
          <option value="yes">موافق</option><option value="no">غير موافق</option>
        </select>
      </label>
      <label className="text-xs font-bold text-navy-900" htmlFor={`${uid}-source`}>كيف أُخذت
        <select id={`${uid}-source`} value={source} onChange={event => setSource(event.target.value as ConsentSource)} className="mt-1 block min-h-11 rounded-xl border border-slate-300 px-2 text-sm">
          {MANUAL_CONSENT_SOURCES.map(value => <option key={value} value={value}>{CONSENT_SOURCE_LABEL[value]}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => void submit()} disabled={busy} className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">تسجيل الموافقة</button>
      {message ? <p role={message.ok ? "status" : "alert"} className={`w-full text-xs ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p> : null}
    </div>
  );
}

const EDIT_FIELDS = [
  ["fullName", "الاسم الكامل", false], ["phone", "الجوال", true], ["altPhone", "رقم بديل", true], ["address", "العنوان", false],
  ["guardianName", "وليّ الأمر", false], ["guardianPhone", "جوال وليّ الأمر", true], ["nationalId", "رقم الهوية", true], ["email", "البريد", true],
] as const;
const CARE_EDIT_FIELDS = [["medicalAlert", "التنبيه الطبي"], ["note", "ملاحظة"]] as const;

/**
 * تعديل بيانات المريض: تُرسل الحقول التي تغيّرت فقط. الحقول السريرية تظهر لمن يرى
 * الملخص العلاجي وحده، والخادم يرفض أي حقل خارج صلاحية الحساب ويسمّيه.
 */
function PatientEditForm({ patient, care, patientId, onCancel, onSaved }: {
  patient: CorePatient; care: boolean; patientId: string; onCancel: () => void; onSaved: (saved: Partial<CorePatient>) => void;
}) {
  const uid = useId();
  const fields = [...EDIT_FIELDS.map(([key, label, ltr]) => [key, label, ltr] as const), ...(care ? CARE_EDIT_FIELDS.map(([key, label]) => [key, label, false] as const) : [])];
  const initial = Object.fromEntries(fields.map(([key]) => [key, String((patient as unknown as Record<string, unknown>)[key] ?? "")]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== initial[key]));
  async function save() {
    if (Object.keys(changed).length === 0) { onCancel(); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/patients/${encodeURIComponent(patientId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changed),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر حفظ التعديل."); return; }
      onSaved(payload as Partial<CorePatient>);
    } catch { setError("تعذّر الاتصال بالخادم. لم يُعتبر التعديل محفوظًا."); }
    finally { setBusy(false); }
  }
  return (
    <section aria-labelledby={`${uid}-title`} className="rounded-2xl border border-navy-200 bg-white p-4" data-testid="patient-edit-form">
      <h2 id={`${uid}-title`} className="mb-2 text-sm font-bold text-navy-900">تعديل بيانات المريض</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map(([key, label, ltr]) => (
          <label key={key} htmlFor={`${uid}-${key}`} className="text-xs font-bold text-navy-900">{label}
            <input id={`${uid}-${key}`} value={values[key]} dir={ltr ? "ltr" : undefined} disabled={busy}
              onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))}
              className="mt-1 block min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm" />
          </label>
        ))}
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void save()} disabled={busy} className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">حفظ التعديل</button>
        <button type="button" onClick={onCancel} disabled={busy} className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-navy-900">إلغاء</button>
      </div>
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


interface PlannedVisitItem {
  id: number; title: string; planTitle: string | null; sequence: number; durationMinutes: number; doctorName: string | null;
  status: "planned" | "scheduled" | "in_progress" | "completed" | "cancelled"; appointmentId: number | null;
  appointmentDate: string | null; appointmentTime: string | null; durationWarning?: string | null;
  appointmentStatus?: string | null; canRebook?: boolean; rebookBlockedReason?: string | null; rebookGeneration?: string;
}
const PLANNED_STATUS_LABEL: Record<PlannedVisitItem["status"], string> = { planned: "لم تُحجز", scheduled: "محجوزة", in_progress: "قائمة", completed: "منجزة", cancelled: "ملغاة" };

/**
 * الجلسات المخطَّطة من خطة العلاج (M2 slice 22): تُقرأ من ملخص سير العمل الموحّد، وما لم
 * يُحجز منها يُحجز بتاريخٍ ووقت فقط عبر محرّك السعة نفسه على طبيب الحالة المسؤول — يُقرأ
 * سياقه من الخادم لحظة الحجز ولا يُخمَّن. يظهر الحجز لمن يملك appointments.create.
 */
function PlannedVisitsPanel({ patientId, canBook }: { patientId: string; canBook: boolean }) {
  const uid = useId();
  const [version, setVersion] = useState(0);
  const { data, error } = usePatientSection<{ plannedVisits?: PlannedVisitItem[] }>(`/api/patients/${encodeURIComponent(patientId)}/workflow?v=${version}`);
  const [openId, setOpenId] = useState<number | null>(null);
  const [date, setDate] = useState(clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));
  const [time, setTime] = useState("10:00");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState("");
  /* The engine's nearby-appointment warning: a second, explicit click resends with its token. */
  const [nearby, setNearby] = useState<{ visitId: number; mode: "book" | "rebook"; token: string } | null>(null);
  /* One request id per rebooking attempt: a retry after a lost reply sends the SAME id,
     so the server replays the first result instead of booking twice. */
  const attempt = useRef<{ visitId: number; body: string } | null>(null);
  const visits = (data?.plannedVisits ?? []).filter(visit => visit.status !== "completed" && visit.status !== "cancelled");

  async function rebook(visit: PlannedVisitItem, confirmationToken?: string) {
    if (!visit.appointmentId || !visit.rebookGeneration) return;
    setBusy(true); setMessage(null);
    try {
      if (attempt.current?.visitId !== visit.id) {
        const contextResponse = await fetch(`/api/patients/${encodeURIComponent(patientId)}/return-booking-context?kind=planned_visit&sourceId=${visit.id}`, { cache: "no-store" });
        const context = await contextResponse.json().catch(() => null);
        if (!contextResponse.ok || typeof context?.fingerprint !== "string") { setMessage({ ok: false, text: context?.message ?? "تعذّر التحقق من الطبيب المسؤول عن الحالة." }); return; }
        attempt.current = { visitId: visit.id, body: JSON.stringify({
          expectedAppointmentId: visit.appointmentId, expectedGeneration: visit.rebookGeneration, date, time,
          reason: reason.trim(), requestId: crypto.randomUUID(), returnBookingFingerprint: context.fingerprint,
        }) };
      }
      // The confirmation is not part of the intent: the same request id stays valid.
      const body = confirmationToken ? JSON.stringify({ ...JSON.parse(attempt.current.body), nearbyAppointmentConfirmation: confirmationToken }) : attempt.current.body;
      const response = await fetch(`/api/planned-visits/${visit.id}/rebook`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (payload?.conflict?.kind === "nearby_patient_appointments" && typeof payload.conflict.confirmationToken === "string") {
          setNearby({ visitId: visit.id, mode: "rebook", token: payload.conflict.confirmationToken });
        } else attempt.current = null;
        const reasons: string[] = Array.isArray(payload?.conflict?.reasons) ? payload.conflict.reasons : [];
        setMessage({ ok: false, text: [payload?.message ?? "تعذّر إعادة الحجز.", ...reasons].filter(Boolean).join(" — ") });
        return;
      }
      attempt.current = null;
      setOpenId(null); setReason(""); setNearby(null);
      setMessage({ ok: true, text: payload?.replayed ? "أُعيد حجز الجلسة سابقًا بهذا الطلب — لم يُنشأ موعد آخر." : `أُعيد حجز الجلسة ${date} الساعة ${time}.` });
      setVersion(current => current + 1);
    } catch { setMessage({ ok: false, text: "انقطع الرد وقد يكون الحجز قد تم. أعد المحاولة نفسها — لن يُنشأ موعد مكرر." }); }
    finally { setBusy(false); }
  }

  async function book(visit: PlannedVisitItem, confirmationToken?: string) {
    if (!confirmationToken && visit.durationWarning && !window.confirm(`${visit.durationWarning}\nالمدة الأصلية: ${visit.durationMinutes} دقيقة. هل راجعتها وتريد الحجز بهذه المدة؟`)) return;
    setBusy(true); setMessage(null);
    try {
      // The responsible doctor is read from the server at booking time, never guessed.
      const contextResponse = await fetch(`/api/patients/${encodeURIComponent(patientId)}/return-booking-context?kind=planned_visit&sourceId=${visit.id}`, { cache: "no-store" });
      const context = await contextResponse.json().catch(() => null);
      if (!contextResponse.ok || typeof context?.fingerprint !== "string") { setMessage({ ok: false, text: context?.message ?? "تعذّر التحقق من الطبيب المسؤول عن الحالة." }); return; }
      const response = await fetch(`/api/planned-visits/${visit.id}/schedule`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, time, returnBookingFingerprint: context.fingerprint, ...(confirmationToken ? { nearbyAppointmentConfirmation: confirmationToken } : {}) }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (payload?.kind === "nearby_patient_appointments" && typeof payload.confirmationToken === "string") setNearby({ visitId: visit.id, mode: "book", token: payload.confirmationToken });
        const reasons: string[] = Array.isArray(payload?.reasons) ? payload.reasons : [];
        setMessage({ ok: false, text: [payload?.message ?? "تعذّر حجز الجلسة.", ...reasons, payload?.suggestionMessage].filter(Boolean).join(" — ") });
        return;
      }
      setOpenId(null); setNearby(null);
      setMessage({ ok: true, text: `حُجزت الجلسة ${date} الساعة ${time}${typeof payload?.doctorName === "string" ? ` — الطبيب: ${payload.doctorName}` : ""}.` });
      setVersion(current => current + 1);
    } catch { setMessage({ ok: false, text: "تعذّر الاتصال بالخادم. لم يُعتبر الحجز تامًّا؛ حدّث الملف قبل إعادة المحاولة." }); }
    finally { setBusy(false); }
  }

  const field = "mt-1 block min-h-11 w-full rounded-xl border border-slate-300 px-2 text-sm";
  return (
    <section aria-labelledby={`${uid}-title`} className="rounded-2xl border border-slate-200 bg-white p-4" data-testid="planned-visits">
      <h2 id={`${uid}-title`} className="mb-2 text-sm font-bold text-navy-900">الجلسات المخطَّطة</h2>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {data && visits.length === 0 ? <p className="text-sm text-slate-500">لا جلسات مخطَّطة مفتوحة.</p> : null}
      <ul className="divide-y divide-slate-100 text-sm">
        {visits.map(visit => (
          <li key={visit.id} className="py-2" data-planned-visit={visit.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-slate-800">{visit.title}{visit.planTitle ? <span className="text-xs text-slate-500"> — {visit.planTitle}</span> : null}</span>
              <span className="rounded-lg bg-slate-50 px-2 py-0.5 text-xs font-bold text-slate-600">
                {PLANNED_STATUS_LABEL[visit.status]}{visit.appointmentDate ? ` · ${visit.appointmentDate} ${visit.appointmentTime ?? ""}` : ""}{visit.appointmentStatus === "no_show" || visit.appointmentStatus === "cancelled" ? ` · ${STATUS_LABEL[visit.appointmentStatus]}` : ""}
              </span>
            </div>
            <p className="text-xs text-slate-600">{visit.durationMinutes} دقيقة{visit.doctorName ? ` · ${visit.doctorName}` : ""}</p>
            {visit.canRebook ? (
              openId === visit.id ? (
                <div className="mt-2 flex max-w-full flex-wrap items-end gap-2">
                  <label htmlFor={`${uid}-${visit.id}-rdate`} className="text-xs font-bold text-navy-900">التاريخ
                    <input id={`${uid}-${visit.id}-rdate`} type="date" dir="ltr" value={date} disabled={busy} onChange={event => { attempt.current = null; setDate(event.target.value); }} className={field} />
                  </label>
                  <label htmlFor={`${uid}-${visit.id}-rtime`} className="text-xs font-bold text-navy-900">الوقت
                    <input id={`${uid}-${visit.id}-rtime`} type="time" dir="ltr" value={time} disabled={busy} onChange={event => { attempt.current = null; setTime(event.target.value); }} className={field} />
                  </label>
                  <label htmlFor={`${uid}-${visit.id}-reason`} className="text-xs font-bold text-navy-900">سبب إعادة الحجز
                    <input id={`${uid}-${visit.id}-reason`} value={reason} disabled={busy} onChange={event => { attempt.current = null; setReason(event.target.value); }} className={field} />
                  </label>
                  <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void rebook(visit)} className="min-h-11 rounded-xl bg-navy-900 px-4 text-xs font-bold text-white disabled:opacity-50">أعد الحجز</button>
                </div>
              ) : (
                <button type="button" onClick={() => { setOpenId(visit.id); setMessage(null); attempt.current = null; }} className="mt-2 min-h-11 rounded-xl border border-navy-200 px-3 text-xs font-bold text-navy-800">أعد حجز الجلسة</button>
              )
            ) : visit.rebookBlockedReason && (visit.appointmentStatus === "no_show" || visit.appointmentStatus === "cancelled") ? (
              <p className="mt-1 text-xs text-amber-800">{visit.rebookBlockedReason}</p>
            ) : null}
            {canBook && visit.status === "planned" && !visit.appointmentId ? (
              openId === visit.id ? (
                <div className="mt-2 flex max-w-full flex-wrap items-end gap-2">
                  <label htmlFor={`${uid}-${visit.id}-date`} className="text-xs font-bold text-navy-900">التاريخ
                    <input id={`${uid}-${visit.id}-date`} type="date" dir="ltr" value={date} disabled={busy} onChange={event => setDate(event.target.value)} className={field} />
                  </label>
                  <label htmlFor={`${uid}-${visit.id}-time`} className="text-xs font-bold text-navy-900">الوقت
                    <input id={`${uid}-${visit.id}-time`} type="time" dir="ltr" value={time} disabled={busy} onChange={event => setTime(event.target.value)} className={field} />
                  </label>
                  <button type="button" disabled={busy} onClick={() => void book(visit)} className="min-h-11 rounded-xl bg-navy-900 px-4 text-xs font-bold text-white disabled:opacity-50">احجز الجلسة</button>
                </div>
              ) : (
                <button type="button" onClick={() => { setOpenId(visit.id); setMessage(null); }} className="mt-2 min-h-11 rounded-xl border border-navy-200 px-3 text-xs font-bold text-navy-800">حدّد موعد الجلسة</button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {message ? <p role={message.ok ? "status" : "alert"} className={`mt-2 text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p> : null}
      {nearby ? (() => {
        const target = visits.find(visit => visit.id === nearby.visitId);
        return target ? (
          <button type="button" disabled={busy} onClick={() => void (nearby.mode === "book" ? book(target, nearby.token) : rebook(target, nearby.token))}
            className="mt-2 min-h-11 rounded-xl border border-amber-400 bg-amber-50 px-3 text-xs font-bold text-amber-900">تأكيد الحجز رغم ذلك</button>
        ) : null;
      })() : null}
    </section>
  );
}
