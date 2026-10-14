import type { Patient } from "@/lib/patient";
import styles from "./PatientProfile.module.css";

/** A view of the existing patient record; editing remains in PatientEditor. */
export function PatientIdentityOverview({ patient, onEdit }: { patient: Patient; onEdit: () => void }) {
  const groups = [
    { title: "البيانات الأساسية", rows: [["الاسم الكامل", patient.fullName], ["رقم الملف", patient.patientNumber], ["تاريخ الميلاد", patient.birthDate ?? patient.birthYear], ["رقم الهوية / الجواز", patient.nationalId]] },
    { title: "التواصل ووليّ الأمر", rows: [["رقم الجوال", patient.phone], ["رقم بديل", patient.altPhone], ["البريد الإلكتروني", patient.email], ["العنوان", patient.address], ["وليّ الأمر", patient.guardianName], ["هاتف وليّ الأمر", patient.guardianPhone]] },
    { title: "معلومات الملف", rows: [["مصدر التعارف", patient.referralSource], ["أحاله", patient.referredBy], ["ملاحظات عامة", patient.note]] },
  ];
  return <section aria-label="البيانات الشخصية" className={styles.workspace}>
    <div className={styles.toolbar}><h2>البيانات الشخصية</h2><button type="button" onClick={onEdit} className="rounded-lg border border-sky-200 bg-white px-3 py-2 text-xs font-bold">تعديل البيانات الشخصية</button></div>
    <div className={styles.columns}>{groups.map(group => <section key={group.title} className={styles.card}>
      <h3>{group.title}</h3><dl className={`${styles.body} ${styles.facts}`}>{group.rows.map(([label,value]) => <div key={label}><dt>{label}</dt><dd className="min-w-0 break-words">{value || "لم يسجّل"}</dd></div>)}</dl>
    </section>)}</div>
  </section>;
}
