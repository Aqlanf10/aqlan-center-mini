"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useSetting } from "@/components/SettingsProvider";
import { GENDER_LABEL } from "@/lib/patient";
import {
  readAdministrativePatientChange, receptionPatientFormPatch, visibleReceptionPatientBirthDate,
  type AdministrativePatientChange, type ReceptionPatientForm,
} from "@/lib/patient-administrative-edit";

const fields = [
  { key: "fullName", label: "الاسم الكامل" },
  { key: "phone", label: "رقم الجوال", type: "tel" },
  { key: "altPhone", label: "رقم بديل", type: "tel" },
  { key: "email", label: "البريد الإلكتروني", type: "email" },
  { key: "birthYear", label: "سنة الميلاد", inputMode: "numeric" },
  { key: "birthDate", label: "تاريخ الميلاد (اختياري)", type: "date" },
  { key: "guardianName", label: "وليّ الأمر (للأطفال)" },
  { key: "guardianPhone", label: "هاتف وليّ الأمر", type: "tel" },
  { key: "address", label: "العنوان / الحي" },
  { key: "referredBy", label: "أحاله (اسم المريض الموصي أو الطبيب)" },
] as const;
const inputClass = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-navy-900";

export function ReceptionPatientEditor({ patientId, initial, onSaved, onCancel }: {
  patientId: number;
  initial: ReceptionPatientForm;
  onSaved: (change: AdministrativePatientChange) => void;
  onCancel: () => void;
}) {
  const [baseline] = useState(initial);
  const [{ form }, setDraft] = useState<{ form: ReceptionPatientForm; yearBeforeDate: string | null }>({ form: initial, yearBeforeDate: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => { inFlight.current?.abort(); inFlight.current = null; }, []);
  const sourceList = useSetting("patients.referral_sources");
  const sources = [...new Set([
    ...sourceList.split(",").map((item) => item.trim()).filter(Boolean),
    ...(form.referralSource ? [form.referralSource] : []),
  ])];

  const set = (key: keyof ReceptionPatientForm, value: string) => setDraft(({ form: current, yearBeforeDate }) => {
    if (key === "birthDate") {
      // Selecting a date temporarily supplies its year. Clearing the selection
      // restores the earlier year draft, even if the user had already edited it.
      const earlierYear = yearBeforeDate ?? current.birthYear;
      const birthYear = value ? value.slice(0, 4) : earlierYear;
      return { form: { ...current, birthDate: value, birthYear }, yearBeforeDate: value ? earlierYear : null };
    }
    // Keep the original/explicit date in the draft. A year-only change is
    // reconciled against the actual stored date, not the date on this screen.
    return { form: { ...current, [key]: value }, yearBeforeDate: key === "birthYear" ? null : yearBeforeDate };
  });

  const changes = receptionPatientFormPatch(baseline, form);
  const hasChanges = Object.keys(changes).length > 0;
  const save = async () => {
    if (inFlight.current || !form.fullName.trim() || !hasChanges) return;
    const request = new AbortController();
    inFlight.current = request;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/patients/${patientId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes), signal: request.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (request.signal.aborted || inFlight.current !== request) return;
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "message" in payload ? payload.message : null;
        setError(typeof message === "string" ? message : "تعذّر حفظ البيانات الإدارية.");
        return;
      }
      const confirmed = readAdministrativePatientChange(payload, patientId, changes);
      if (!confirmed) {
        setError("لم يمكن تأكيد البيانات المحفوظة. أعد فتح الملف للتحقق.");
        return;
      }
      onSaved(confirmed);
    } catch {
      if (!request.signal.aborted) setError("تعذّر الاتصال بالخادم.");
    } finally {
      if (inFlight.current === request) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <form aria-label="تعديل البيانات الإدارية" className="mb-4 rounded-2xl border border-navy-800 bg-white p-4 shadow-sm"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h2 className="mb-3 text-sm font-extrabold text-navy-900">تعديل البيانات الإدارية</h2>
      {error ? <p role="alert" className="mb-2 text-sm font-bold text-red-700">{error}</p> : null}
      <fieldset disabled={busy} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {fields.map((field) => (
          <label className="block text-xs font-bold text-slate-700" key={field.key}>
            <span className="mb-1 block">{field.label}</span>
            <input className={inputClass} value={field.key === "birthDate" ? visibleReceptionPatientBirthDate(form) : form[field.key]}
              onChange={(event) => set(field.key, event.target.value)}
              type={"type" in field ? field.type : "text"} inputMode={"inputMode" in field ? field.inputMode : undefined}
              dir={("type" in field || "inputMode" in field) ? "ltr" : undefined} />
          </label>
        ))}
        <label className="block text-xs font-bold text-slate-700">
          <span className="mb-1 block">الجنس</span>
          <select className={inputClass} value={form.gender} onChange={(event) => set("gender", event.target.value)}>
            {Object.entries(GENDER_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="block text-xs font-bold text-slate-700">
          <span className="mb-1 block">من أين عرفنا؟</span>
          <select className={inputClass} value={form.referralSource} onChange={(event) => set("referralSource", event.target.value)}>
            <option value="">— غير محدد —</option>
            {sources.map((source) => <option key={source} value={source}>{source}</option>)}
          </select>
        </label>
      </fieldset>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold">إلغاء</button>
        <button type="submit" disabled={busy || !hasChanges || !form.fullName.trim()}
          className="rounded-xl bg-navy-800 px-5 py-2 text-xs font-bold text-white disabled:opacity-40">
          {busy ? "جارٍ الحفظ…" : "حفظ التغييرات"}
        </button>
      </div>
    </form>
  );
}
