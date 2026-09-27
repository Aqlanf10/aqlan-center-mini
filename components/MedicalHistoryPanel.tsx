"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ASA_CLASSES, ASA_LABEL, HISTORY_QUESTIONS, SEVERITY_LABEL,
  type Allergy, type Answer, type AsaClass, type DerivedAlert, type Medication, type Severity,
} from "@/lib/medical-history";
import { BLOOD_GROUPS } from "@/lib/patient";

/**
 * (PAT-2) التاريخ الطبي المنظَّم في ملف المريض — كما في الأنظمة الرائدة:
 * تنبيهاتٌ مشتقّة من آخر استبيان، وتنبيه «حان تحديث التاريخ الطبي» بعد مدة الإعداد،
 * وخلاصة (ASA، فصيلة الدم، الحساسية، الأدوية)، وآخر العلامات الحيوية، ونموذج تحديثٍ
 * يحفظ نسخةً جديدة (لا تُعدَّل القديمة).
 */

interface HistoryRecord {
  id: number;
  answers: Record<string, Answer>;
  allergies: Allergy[];
  medications: Medication[];
  asaClass: AsaClass | null;
  bloodGroup: string | null;
  notes: string | null;
  patientConfirmed: boolean;
  recordedBy: string;
  recordedAt: string;
}

interface VitalsRecord {
  id: number; bpSystolic: number | null; bpDiastolic: number | null; pulse: number | null;
  temperature: number | null; spo2: number | null; glucose: number | null; weightKg: number | null;
  recordedBy: string; recordedAt: string;
}

interface Payload {
  latest: HistoryRecord | null;
  versions: { id: number; recordedAt: string; recordedBy: string }[];
  alerts: DerivedAlert[];
  review: { due: boolean; months: number };
  vitals: VitalsRecord[];
}

const dateText = (iso: string) => new Date(iso).toLocaleDateString("ar-YE-u-nu-latn");

export function MedicalHistoryPanel({ patientId }: { patientId: number }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/patients/${patientId}/medical-history`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message ?? "تعذّر تحميل التاريخ الطبي.");
      setData(payload as Payload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل التاريخ الطبي.");
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold text-red-700">{error}</p>;
  if (!data) return null;
  const { latest, alerts, review, vitals } = data;
  const lastVitals = vitals[0] ?? null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="التاريخ الطبي">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-extrabold text-navy-900">التاريخ الطبي</h3>
        <button type="button" onClick={() => setEditing(true)}
          className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-extrabold text-white">
          {latest ? "تحديث التاريخ الطبي" : "+ تعبئة الاستبيان الطبي"}
        </button>
      </div>

      {review.due ? (
        <p className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
          {latest
            ? `مضى أكثر من ${review.months} أشهر على آخر تحديث (${dateText(latest.recordedAt)}) — راجع التاريخ الطبي مع المريض.`
            : "لا يوجد استبيان طبي لهذا المريض بعد — عبّئه قبل أي إجراء."}
        </p>
      ) : null}

      {alerts.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {alerts.map((alert) => (
            <span key={alert.label}
              className={`rounded-lg border px-2 py-0.5 text-[11px] font-extrabold ${alert.severity === "high"
                ? "border-red-300 bg-red-50 text-red-800" : "border-amber-300 bg-amber-50 text-amber-800"}`}>
              ⚠ {alert.label}
            </span>
          ))}
        </div>
      ) : latest ? <p className="mb-2 text-xs font-bold text-emerald-700">لا تنبيهات طبية في آخر استبيان.</p> : null}

      {latest ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-4">
          <div><dt className="text-slate-500">ASA</dt><dd className="font-bold">{latest.asaClass ?? "—"}</dd></div>
          <div><dt className="text-slate-500">فصيلة الدم</dt><dd className="font-bold" dir="ltr">{latest.bloodGroup ?? "—"}</dd></div>
          <div><dt className="text-slate-500">الأدوية</dt><dd className="font-bold">{latest.medications.map((m) => m.name).join("، ") || "—"}</dd></div>
          <div><dt className="text-slate-500">آخر تحديث</dt><dd className="font-bold">{dateText(latest.recordedAt)} · {latest.recordedBy}{latest.patientConfirmed ? " · أكّده المريض" : ""}</dd></div>
        </dl>
      ) : null}

      {lastVitals ? (
        <p className="mt-2 text-[11px] font-bold text-slate-600">
          آخر علامات حيوية ({dateText(lastVitals.recordedAt)}):
          {lastVitals.bpSystolic ? ` الضغط ${lastVitals.bpSystolic}/${lastVitals.bpDiastolic}` : ""}
          {lastVitals.pulse ? ` · النبض ${lastVitals.pulse}` : ""}
          {lastVitals.glucose ? ` · السكر ${lastVitals.glucose}` : ""}
          {lastVitals.temperature ? ` · الحرارة ${lastVitals.temperature}` : ""}
          {lastVitals.spo2 ? ` · الأكسجين ${lastVitals.spo2}%` : ""}
          {lastVitals.weightKg ? ` · الوزن ${lastVitals.weightKg} كغ` : ""}
        </p>
      ) : null}

      {editing ? (
        <HistoryForm patientId={patientId} initial={latest}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); void load(); }} />
      ) : null}
    </section>
  );
}

function HistoryForm({ patientId, initial, onClose, onSaved }: {
  patientId: number;
  initial: HistoryRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, Answer>>(initial?.answers ?? {});
  const [allergies, setAllergies] = useState<Allergy[]>(initial?.allergies ?? []);
  const [medications, setMedications] = useState<Medication[]>(initial?.medications ?? []);
  const [asaClass, setAsaClass] = useState<string>(initial?.asaClass ?? "");
  const [bloodGroup, setBloodGroup] = useState<string>(initial?.bloodGroup ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/medical-history`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers, allergies, medications, asaClass: asaClass || null, bloodGroup: bloodGroup || null, notes, patientConfirmed: confirmed }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setError(payload.message ?? "تعذّر الحفظ."); return; }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  const choice = (key: string, value: Answer, label: string, active: string) => (
    <button type="button" onClick={() => setAnswers({ ...answers, [key]: value })}
      className={`rounded-lg border px-2 py-0.5 text-[11px] font-bold ${(answers[key] ?? "unknown") === value ? active : "border-slate-200 bg-white text-slate-500"}`}>
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/60 p-4" role="dialog" aria-label="الاستبيان الطبي">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-4 shadow-2xl">
        <h3 className="mb-3 text-sm font-extrabold text-navy-900">الاستبيان الطبي — نسخة جديدة</h3>

        <ul className="mb-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
          {HISTORY_QUESTIONS.map((question) => (
            <li key={question.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
              <span className={`text-xs font-bold ${question.risk === "high" ? "text-red-800" : "text-slate-700"}`}>{question.label}</span>
              <span className="flex gap-1">
                {choice(question.key, "yes", "نعم", "border-red-400 bg-red-50 text-red-800")}
                {choice(question.key, "no", "لا", "border-emerald-400 bg-emerald-50 text-emerald-800")}
                {choice(question.key, "unknown", "لا يعرف", "border-slate-400 bg-slate-100 text-slate-700")}
              </span>
            </li>
          ))}
        </ul>

        <fieldset className="mb-3 rounded-xl border border-slate-200 p-3">
          <legend className="px-1 text-xs font-extrabold text-navy-900">الحساسية</legend>
          {allergies.map((allergy, index) => (
            <div key={index} className="mb-1.5 flex flex-wrap gap-1.5">
              <input value={allergy.substance} placeholder="المادة (بنسلين، لاتكس، مخدر موضعي…)" aria-label="مادة الحساسية"
                onChange={(e) => setAllergies(allergies.map((row, i) => i === index ? { ...row, substance: e.target.value } : row))}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
              <input value={allergy.reaction ?? ""} placeholder="التفاعل" aria-label="التفاعل"
                onChange={(e) => setAllergies(allergies.map((row, i) => i === index ? { ...row, reaction: e.target.value } : row))}
                className="w-28 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
              <select value={allergy.severity} aria-label="الشدة"
                onChange={(e) => setAllergies(allergies.map((row, i) => i === index ? { ...row, severity: e.target.value as Severity } : row))}
                className="rounded-lg border border-slate-200 px-1 text-xs">
                {(Object.entries(SEVERITY_LABEL) as [Severity, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" onClick={() => setAllergies(allergies.filter((_, i) => i !== index))} className="text-xs font-bold text-red-700">حذف</button>
            </div>
          ))}
          <button type="button" onClick={() => setAllergies([...allergies, { substance: "", reaction: null, severity: "moderate" }])}
            className="text-xs font-bold text-navy-800">+ حساسية</button>
        </fieldset>

        <fieldset className="mb-3 rounded-xl border border-slate-200 p-3">
          <legend className="px-1 text-xs font-extrabold text-navy-900">الأدوية الحالية</legend>
          {medications.map((medication, index) => (
            <div key={index} className="mb-1.5 flex flex-wrap gap-1.5">
              <input value={medication.name} placeholder="اسم الدواء" aria-label="اسم الدواء"
                onChange={(e) => setMedications(medications.map((row, i) => i === index ? { ...row, name: e.target.value } : row))}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
              <input value={medication.dose ?? ""} placeholder="الجرعة" aria-label="الجرعة"
                onChange={(e) => setMedications(medications.map((row, i) => i === index ? { ...row, dose: e.target.value } : row))}
                className="w-32 rounded-lg border border-slate-200 px-2 py-1 text-xs" />
              <button type="button" onClick={() => setMedications(medications.filter((_, i) => i !== index))} className="text-xs font-bold text-red-700">حذف</button>
            </div>
          ))}
          <button type="button" onClick={() => setMedications([...medications, { name: "", dose: null }])}
            className="text-xs font-bold text-navy-800">+ دواء</button>
        </fieldset>

        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <label className="text-xs font-bold text-slate-600">تصنيف ASA
            <select value={asaClass} onChange={(e) => setAsaClass(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs">
              <option value="">— غير محدد —</option>
              {ASA_CLASSES.map((value) => <option key={value} value={value}>{ASA_LABEL[value]}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-600">فصيلة الدم
            <select value={bloodGroup} onChange={(e) => setBloodGroup(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs" dir="ltr">
              <option value="">—</option>
              {BLOOD_GROUPS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ملاحظات طبية أخرى" aria-label="ملاحظات طبية"
          className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs" rows={2} />
        <label className="mb-3 flex items-center gap-2 text-xs font-bold text-slate-700">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          راجع المريض (أو وليّه) الإجابات وأكّد صحتها
        </label>

        {error ? <p role="alert" className="mb-2 text-xs font-bold text-red-700">{error}</p> : null}
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void save()}
            className="flex-1 rounded-xl bg-navy-800 py-2 text-xs font-extrabold text-white disabled:opacity-40">حفظ نسخة جديدة</button>
          <button type="button" onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold">إلغاء</button>
        </div>
      </div>
    </div>
  );
}
