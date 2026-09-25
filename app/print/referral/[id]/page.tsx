import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getPatient, getReferral, getSettingsSafe } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { isAdmin } from "@/lib/roles";
import { ageFromBirthDate, ageFromBirthYear, ageText, GENDER_LABEL } from "@/lib/patient";
import { REFERRAL_SPECIALTY_LABEL, REFERRAL_URGENCY_LABEL } from "@/lib/referrals";
import { clinicDateString } from "@/lib/schedule";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P3-8) خطاب إحالة — A5 باسم المركز والطبيب.
 *
 * يحمله المريض إلى الجرّاح أو الأخصائي: من هو، ولماذا أُحيل، وأي الأسنان بترقيم
 * FDI، والتنبيه الطبي (الحساسية والأمراض المزمنة) — فالجرّاح الذي يقلع يحتاجه قبل
 * أي شيء. ويُطبع من السجل كما حُفظ، لا من مسودة.
 */
export default async function ReferralPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) notFound();
  // وثيقة سريرية: الطبيب أو المدير — ومن يفتحها يملك المريض.
  if (!isAdmin(session.role) && session.role !== "doctor") notFound();

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const referral = await getReferral(id);
  if (!referral) notFound();
  if (!(await canAccessPatient(session, referral.patientId).catch(() => false))) notFound();

  const [patient, settings] = await Promise.all([getPatient(referral.patientId), getSettingsSafe()]);
  if (!patient) notFound();

  const date = clinicDateString(new Date(referral.createdAt), CLINIC_TIME_ZONE);
  const age = ageFromBirthDate(patient.birthDate, date) ?? ageFromBirthYear(patient.birthYear, date);
  const doctor = referral.doctorName ?? settings["clinic.lead_doctor"];

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a5">
        <PrintHeader settings={settings} title="خطاب إحالة" compact />

        <div className="line"><span>التاريخ</span><span>{friendlyDateLong(date)}</span></div>
        <div className="line">
          <span>إلى الزميل</span>
          <span style={{ fontWeight: 800 }}>{referral.toName} — {REFERRAL_SPECIALTY_LABEL[referral.toSpecialty]}</span>
        </div>
        {referral.urgency !== "routine" ? (
          <div className="line"><span>الاستعجال</span><span style={{ fontWeight: 800 }}>{REFERRAL_URGENCY_LABEL[referral.urgency]}</span></div>
        ) : null}
        <div className="rule" />

        <div className="line"><span>المريض</span><span style={{ fontWeight: 800 }}>{patient.fullName}</span></div>
        <div className="line"><span>رقم الملف</span><span className="num" dir="ltr">{patient.patientNumber}</span></div>
        <div className="line"><span>العمر / الجنس</span><span>{ageText(age)} · {GENDER_LABEL[patient.gender]}</span></div>
        {patient.medicalAlert ? (
          <div style={{ margin: "2mm 0", padding: "1.5mm 2mm", border: "1px solid #dc2626", borderRadius: "1.5mm", fontSize: "9pt" }}>
            <span style={{ fontWeight: 800, color: "#b91c1c" }}>تنبيه طبي: </span>
            <span>{patient.medicalAlert}</span>
          </div>
        ) : null}

        <p style={{ fontSize: "9.5pt", margin: "3mm 0 1.5mm" }}>
          تحية طيبة، نحيل إليكم المريض المذكور أعلاه للآتي:
        </p>
        <p style={{ fontSize: "10pt", fontWeight: 700, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{referral.reason}</p>
        {referral.teeth ? (
          <div className="line" style={{ marginTop: "2mm" }}>
            <span>الأسنان (FDI)</span>
            <span className="num" dir="ltr" style={{ fontWeight: 800 }}>{referral.teeth}</span>
          </div>
        ) : null}
        <p style={{ fontSize: "9pt", color: "#475569", marginTop: "3mm" }}>
          نرجو إفادتنا بما تم لنتابع خطة العلاج. وتفضلوا بقبول فائق الاحترام.
        </p>

        <div className="sign-row" style={{ marginTop: "10mm", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: "8pt", color: "#64748b" }}>الطبيب المعالج</div>
            <div style={{ fontWeight: 800, fontSize: "9pt", marginTop: "1mm" }}>{doctor}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "8pt", color: "#64748b" }}>التوقيع والختم</div>
            <div style={{ height: "10mm", width: "30mm", borderBottom: "1px dotted #94a3b8", margin: "2mm auto 0" }} />
          </div>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
