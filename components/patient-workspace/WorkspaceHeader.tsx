"use client";

import { Activity, ArrowUpLeft, CalendarPlus, ShieldAlert, UserRound } from "lucide-react";
import { ageFromBirthDate, ageFromBirthYear, ageText, GENDER_LABEL, parsePatientVitals, type Patient } from "@/lib/patient";
import { PatientFlagChips } from "@/components/PatientContactPanel";
import type { usePatientReadiness } from "./usePatientReadiness";
import styles from "./workspace.module.css";

/** NEW RECONSTRUCTION. Read-only context; all commands retain their original owners. */
export function WorkspaceHeader({ patient, today, readiness, canEdit, canOperate, onBook, onNavigate, onVitals }: {
  patient: Patient; today: string; readiness: ReturnType<typeof usePatientReadiness>;
  canEdit: boolean; canOperate: boolean; onBook: () => void; onNavigate: (target: string) => void; onVitals: () => void;
}) {
  const age = patient.birthDate ? ageFromBirthDate(patient.birthDate, today) : ageFromBirthYear(patient.birthYear, today);
  const { vitals } = parsePatientVitals(patient.medicalAlert);
  return <header className={styles.header} data-testid="patient-workspace-header">
    <div className={styles.identityRow}>
      <div className={styles.identity}>
        <span className={styles.avatar} aria-hidden="true"><UserRound size={30} /></span>
        <div className={styles.identityText}>
          <p className={styles.eyebrow}>ملف المريض · MINI</p><h1>{patient.fullName}</h1>
          <div className={styles.metadata}>
            <span>رقم الملف <bdi className={styles.patientNumber}>{patient.patientNumber}</bdi></span>
            <span>{ageText(age)}</span><span>{GENDER_LABEL[patient.gender] ?? "غير محدد"}</span>
            {patient.phone ? <bdi dir="ltr">{patient.phone}</bdi> : <span>الهاتف غير مسجّل</span>}
          </div>
          <PatientFlagChips flags={patient.flags ?? []} />
        </div>
      </div>
      <div className={styles.headerActions}>
        <span className={styles.dateContext}>يوم العيادة <bdi>{today}</bdi></span>
        <div className={styles.actions}>
          {canOperate ? <button type="button" className={styles.primaryButton} onClick={onBook}><CalendarPlus size={17} aria-hidden="true" />حجز موعد</button> : null}
          <button type="button" className={styles.button} onClick={() => onNavigate("today")}>زيارة اليوم<ArrowUpLeft size={16} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
    <div className={styles.safetyStrip} aria-label="التنبيهات والمراجعة الطبية">
      <ShieldAlert size={20} aria-hidden="true" />
      <div className={styles.safetyCopy}>
        <strong>التنبيهات الطبية</strong>
        {readiness.alerts.length ? <ul>{readiness.alerts.map((alert, index) => <li key={`${index}:${alert}`}>{alert}</li>)}</ul> : <p>لا يظهر تنبيه نصّي مسجّل حاليًا</p>}
        <p className={styles.safetyHint}>عدم ظهور تنبيه لا يؤكد اكتمال المراجعة؛ راجع التاريخ الطبي والقياسات قبل الإجراء</p>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={() => onNavigate("identity")}>التاريخ الطبي</button>
        {canEdit ? <button type="button" className={styles.button} onClick={onVitals}><Activity size={16} aria-hidden="true" />العلامات الحيوية</button> : null}
      </div>
    </div>
    {vitals ? <div className={styles.vitalsContext} aria-label="آخر قياسات مسجّلة في التنبيه">
      <span>قياسات مسجّلة {vitals.recordedAt ? <bdi>{vitals.recordedAt}</bdi> : "بلا تاريخ مؤكّد"}</span>
      {vitals.bpSystolic != null && vitals.bpDiastolic != null ? <span>الضغط <bdi>{vitals.bpSystolic}/{vitals.bpDiastolic}</bdi></span> : null}
      {vitals.pulse != null ? <span>النبض <bdi>{vitals.pulse}</bdi></span> : null}
      {vitals.bloodSugar != null ? <span>السكر <bdi>{vitals.bloodSugar} mg/dL</bdi></span> : null}
      <span>قراءات للتوثيق؛ لا تمنح تصريحًا علاجيًا</span>
    </div> : null}
    <div className={styles.visitStrip}>
      <div><span className={styles.eyebrow}>حالة الزيارة</span><p className={styles.visitStatus}>{readiness.statusLine}</p></div>
      {readiness.readinessKnown && readiness.visit?.cleared ? <span className={styles.statusPill}>إقرار مراجعة محفوظ · <bdi>{readiness.visit.cleared.at.slice(0, 10)}</bdi></span> : null}
      <div className={styles.actions}>
        {canOperate && readiness.active && readiness.visit?.checklist && !readiness.visit.cleared ? <button type="button" className={styles.softButton} disabled={readiness.busy || !readiness.readinessKnown} onClick={() => void readiness.clear()}>مراجعة وإقرار الجاهزية</button> : null}
        {canOperate && readiness.canEnterChair ? <>
          <label className={styles.chairLabel}>الكرسي<select value={readiness.selectedChair ?? ""} onChange={(event) => readiness.setChair(Number(event.target.value))} disabled={readiness.busy || !readiness.chairsKnown}>
            {!readiness.freeChairs.length ? <option value="">غير متاح</option> : readiness.freeChairs.map((chair) => <option key={chair} value={chair}>كرسي {chair}</option>)}
          </select></label>
          <button type="button" className={styles.softButton} onClick={() => void readiness.enterChair()} disabled={readiness.busy || !readiness.readinessKnown || !readiness.chairsKnown || readiness.selectedChair === null}>{readiness.busy ? "جارٍ التحقق…" : "إدخال إلى الكرسي"}</button>
        </> : null}
      </div>
    </div>
    {readiness.message ? <p role={readiness.message.tone === "error" ? "alert" : "status"} className={readiness.message.tone === "error" ? styles.error : styles.notice}>{readiness.message.text}</p> : null}
  </header>;
}
