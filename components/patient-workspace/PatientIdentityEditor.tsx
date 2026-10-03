"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSetting } from "@/components/SettingsProvider";
import type { Patient } from "@/lib/patient";
import styles from "./workspace.module.css";

const formFor = (patient: Patient) => ({ fullName: patient.fullName, phone: patient.phone ?? "", altPhone: patient.altPhone ?? "", gender: patient.gender,
  birthYear: patient.birthYear ? String(patient.birthYear) : "", birthDate: patient.birthDate ?? "", address: patient.address ?? "",
  medicalAlert: patient.medicalAlert ?? "", note: patient.note ?? "", guardianName: patient.guardianName ?? "", guardianPhone: patient.guardianPhone ?? "",
  nationalId: patient.nationalId ?? "", referralSource: patient.referralSource ?? "", referredBy: patient.referredBy ?? "" });
type IdentityForm = ReturnType<typeof formFor>;
const pendingPatientWrites = new Set<number>();
// Session-local containment only: remounting must not turn an unknown write into
// a new attempt. Reloading is not evidence that the server rejected it.
const unresolvedPatientWrites = new Set<number>();
const writeObservers = new Map<number, Set<() => void>>();
const notifyWrite = (patientId: number) => writeObservers.get(patientId)?.forEach((notify) => notify());
const definitiveRejection = (status: number) => status >= 400 && status < 500 && ![408, 499].includes(status);

/** NEW RECONSTRUCTION. Only changed fields are sent to the canonical PATCH owner. */
export function PatientIdentityEditor({ patient, onSaved, onError }: {
  patient: Patient; onSaved: (patient: Patient) => void; onError: (message: string | null) => void;
}) {
  return <IdentityDraft key={patient.id} patient={patient} onSaved={onSaved} onError={onError} />;
}
function IdentityDraft({ patient, onSaved, onError }: { patient: Patient; onSaved: (patient: Patient) => void; onError: (message: string | null) => void }) {
  const [baseline, setBaseline] = useState(() => formFor(patient));
  const [form, setForm] = useState(() => formFor(patient));
  const [saving, setSaving] = useState(() => pendingPatientWrites.has(patient.id));
  const [uncertain, setUncertain] = useState(() => unresolvedPatientWrites.has(patient.id));
  const [notice, setNotice] = useState<string | null>(null);
  const [draftToken, setDraftToken] = useState(() => ({}));
  const activeDraftToken = useRef(draftToken);
  const mounted = useRef(false); const inFlight = useRef(false); const dirtyRef = useRef(false);
  const sourceList = useSetting("patients.referral_sources");
  const sources = Array.from(new Set([...sourceList.split(",").map((source) => source.trim()).filter(Boolean), ...(form.referralSource ? [form.referralSource] : [])]));
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const remoteChanged = JSON.stringify(formFor(patient)) !== JSON.stringify(baseline);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  // Retire at commit time; passive cleanup is too late for a resolved response.
  useLayoutEffect(() => {
    mounted.current = true;
    const notify = () => { setSaving(pendingPatientWrites.has(patient.id)); setUncertain(unresolvedPatientWrites.has(patient.id)); };
    const observers = writeObservers.get(patient.id) ?? new Set<() => void>();
    observers.add(notify); writeObservers.set(patient.id, observers);
    const guard = (event: BeforeUnloadEvent) => { if (pendingPatientWrites.has(patient.id) || unresolvedPatientWrites.has(patient.id) || dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => { mounted.current = false; observers.delete(notify); if (!observers.size) writeObservers.delete(patient.id); window.removeEventListener("beforeunload", guard); };
  }, [patient.id]);
  const ownsDraft = () => mounted.current && draftToken === activeDraftToken.current;
  const blocked = () => !ownsDraft() || inFlight.current || pendingPatientWrites.has(patient.id) || unresolvedPatientWrites.has(patient.id);
  const set = (key: keyof IdentityForm, value: string) => {
    if (blocked()) return;
    setForm((current) => key === "birthDate" ? { ...current, birthDate: value, birthYear: value ? value.slice(0, 4) : current.birthYear }
      : key === "birthYear" && current.birthDate && current.birthDate.slice(0, 4) !== value ? { ...current, birthYear: value, birthDate: "" }
        : { ...current, [key]: value });
  };
  const reset = () => {
    if (blocked() || (dirty && !window.confirm("تجاهل تعديلات البيانات غير المحفوظة؟"))) return;
    const token = {}; activeDraftToken.current = token; setDraftToken(token);
    const next = formFor(patient); dirtyRef.current = false; setBaseline(next); setForm(next); setNotice(null); onError(null);
  };
  const save = async () => {
    if (blocked() || !dirty || !dirtyRef.current || remoteChanged) return;
    inFlight.current = true; pendingPatientWrites.add(patient.id); notifyWrite(patient.id); onError(null); setNotice(null);
    const changed = Object.fromEntries((Object.keys(form) as Array<keyof IdentityForm>).filter((key) => form[key] !== baseline[key]).map((key) => [key, form[key]]));
    try {
      const response = await fetch(`/api/patients/${patient.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changed) });
      const payload = await response.json().catch(() => null);
      if (!response.ok && definitiveRejection(response.status)) {
        if (ownsDraft()) onError(typeof payload?.message === "string" ? payload.message : "تعذّر حفظ بيانات المريض.");
        return;
      }
      if (!response.ok || response.status < 200 || response.status >= 300 || !payload || payload.id !== patient.id || payload.patientNumber !== patient.patientNumber || typeof payload.fullName !== "string" || !(payload.medicalAlert === null || typeof payload.medicalAlert === "string")) {
        unresolvedPatientWrites.add(patient.id); notifyWrite(patient.id);
        if (ownsDraft()) onError("لم يمكن تأكيد نتيجة الحفظ؛ قد يكون اكتمل. راجع البيانات المحفوظة وسجل التدقيق قبل أي محاولة جديدة.");
        return;
      }
      if (!ownsDraft()) return;
      const token = {}; activeDraftToken.current = token; setDraftToken(token);
      dirtyRef.current = false;
      const next = formFor(payload as Patient); setBaseline(next); setForm(next); setNotice("حُفظت البيانات من المصدر المعتمد."); onSaved(payload as Patient);
    } catch {
      unresolvedPatientWrites.add(patient.id); notifyWrite(patient.id);
      if (ownsDraft()) onError("انقطع الاتصال؛ قد يكون الحفظ اكتمل. راجع البيانات المحفوظة وسجل التدقيق قبل أي محاولة جديدة.");
    } finally { pendingPatientWrites.delete(patient.id); inFlight.current = false; notifyWrite(patient.id); }
  };
  const field = (key: keyof IdentityForm, label: string, type = "text", direction?: "ltr") => <label className={styles.field} key={key}><span>{label}</span><input type={type} dir={direction} value={form[key]} onChange={(event) => set(key, event.target.value)} /></label>;
  return <form className={styles.identityForm} onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label="تعديل البيانات الأساسية">
    <div className={styles.panelHeading}><h3 className={styles.panelTitle}>بيانات المريض</h3><span className={styles.context}>رقم الملف <bdi>{patient.patientNumber}</bdi></span></div>
    {remoteChanged ? <p className={styles.notice} role="status">تغيّرت البيانات المحفوظة أثناء فتح المحرّر. راجعها بإعادة ضبط النموذج قبل الحفظ.</p> : null}
    {uncertain ? <p className={styles.error} role="alert">نتيجة الحفظ غير مؤكّدة؛ التعديل متوقف في هذه الجلسة لحماية السجل. احتفظ بنص التعديلات وراجع البيانات المحفوظة وسجل التدقيق. إعادة تحميل الصفحة قد تزيل هذا التحذير لكنها لا تؤكد النتيجة ولا تجعل تكرار الحفظ آمنًا.</p> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    <fieldset disabled={saving || uncertain} className={styles.formFields}>
      <legend className={styles.srOnly}>الهوية والتواصل</legend>
      <div className={styles.formGrid}>{field("fullName", "الاسم الكامل")}{field("phone", "رقم الجوال", "tel", "ltr")}{field("altPhone", "رقم بديل", "tel", "ltr")}
        <label className={styles.field}><span>الجنس</span><select value={form.gender} onChange={(event) => set("gender", event.target.value)}><option value="unknown">غير محدد</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label>
        {field("birthDate", "تاريخ الميلاد (اختياري)", "date", "ltr")}{field("birthYear", "سنة الميلاد", "text", "ltr")}
      </div>
      <label className={styles.field}><span>التنبيه الطبي</span><textarea rows={3} maxLength={800} value={form.medicalAlert} onChange={(event) => set("medicalAlert", event.target.value)} /><small>لا يمسح ترك الحقل فارغًا التاريخ الطبي المنظّم أو تنبيهاته</small></label>
      <details className={styles.disclosure}><summary>معلومات إضافية ووليّ الأمر</summary><div className={styles.formGrid}>
        {field("address", "العنوان")}{field("guardianName", "اسم وليّ الأمر")}{field("guardianPhone", "هاتف وليّ الأمر", "tel", "ltr")}{field("nationalId", "رقم الهوية / الجواز", "text", "ltr")}
        <label className={styles.field}><span>مصدر الإحالة</span><select value={form.referralSource} onChange={(event) => set("referralSource", event.target.value)}><option value="">غير محدد</option>{sources.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>{field("referredBy", "اسم من أحاله")}
        <label className={styles.field}><span>ملاحظة إدارية</span><textarea rows={2} maxLength={2000} value={form.note} onChange={(event) => set("note", event.target.value)} /></label>
      </div></details>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primaryButton} disabled={saving || !dirty || remoteChanged || uncertain}>{saving ? "جارٍ الحفظ…" : "حفظ البيانات"}</button><button type="button" className={styles.button} disabled={saving || uncertain} onClick={reset}>{remoteChanged || uncertain ? "إعادة ضبط من الملف الحالي" : "إلغاء التعديلات"}</button></div>
  </form>;
}
