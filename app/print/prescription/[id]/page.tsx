import { PrintMetadata } from "@/components/PrintDocument";
import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getPatient, getPrescription, getSettingsSafe } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { isAdmin } from "@/lib/roles";
import { ageFromBirthYear, ageText, GENDER_LABEL } from "@/lib/patient";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const LEGACY_DRAFT_KEYS = ["draft", "items", "diagnosis", "notes"] as const;
const MAX_DATABASE_ID = 2147483647;

function savedId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value)) return null;
  const id = Number(value);
  return id <= MAX_DATABASE_ID ? id : null;
}

/**
 * الوصفة والروشتة الطبية السنية — مقاس A5 قياسي.
 *
 * وثيقة رسمية تصدر باسم المريض بعد الكشف أو الجراحة، متضمنة التشخيص
 * والتنبيهات الطبية (الحساسية والأمراض المزمنة) وجدول الأدوية والجرعات
 * وتوقيع الطبيب المعالج وختم المركز. جدول الأدوية يُطبع بالإنجليزية —
 * لغة الأسماء الدوائية والصيدليات — والتعليمات للمريض باللغة التي
 * اختارها الطبيب: عربية أو إنجليزية أو كلتاهما.
 */
export default async function PrescriptionPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  /* Saved prescriptions are clinical documents: existing doctor/admin access
     and the patient's own scope still apply. */
  if (!isAdmin(session.role) && session.role !== "doctor") notFound();

  const patientId = savedId((await params).id);
  const query = await searchParams;
  const prescriptionId = savedId(query.rx);
  // Reject the presence of private legacy draft fields even alongside a real
  // saved ID. Empty or repeated fields are not an alternate official transport.
  if (patientId === null || prescriptionId === null
    || LEGACY_DRAFT_KEYS.some(key => Object.hasOwn(query, key))) notFound();

  if (!(await canAccessPatient(session, patientId).catch(() => false))) notFound();
  const stored = await getPrescription(prescriptionId);
  if (!stored || stored.id !== prescriptionId || stored.patientId !== patientId) notFound();

  const [patient, settings] = await Promise.all([getPatient(patientId), getSettingsSafe()]);
  if (!patient || patient.id !== patientId) notFound();

  const { items: rxItems, instructionsLang: lang, diagnosis: diagnosisText, notes: notesText } = stored;
  const dateStr = clinicDateString(new Date(stored.createdAt), CLINIC_TIME_ZONE);
  const age = ageFromBirthYear(patient.birthYear, dateStr);

  return (
    <>
      <PrintButton docType="prescription" docId={stored.id} />
      <div className="sheet sheet-a5">
        <PrintHeader settings={settings} title="وصفة طبية (روشتة)" compact />

        {/* معلومات المريض */}
        <PrintMetadata>
          <div className="line">
            <span style={{ color: "#475569" }}>المريض:</span>
            <span style={{ fontWeight: 800 }}>{patient.fullName}</span>
          </div>
          <div className="line">
            <span style={{ color: "#475569" }}>رقم الملف:</span>
            <span className="num" dir="ltr" style={{ fontWeight: 700 }}>{patient.patientNumber}</span>
          </div>
          <div className="line">
            <span style={{ color: "#475569" }}>العمر / الجنس:</span>
            <span>{ageText(age)} · {GENDER_LABEL[patient.gender]}</span>
          </div>
          <div className="line">
            <span style={{ color: "#475569" }}>التاريخ:</span>
            <span>{friendlyDateLong(dateStr)}</span>
          </div>
        </PrintMetadata>

        {/* تنبيه الحساسية والأمراض المزمنة */}
        {patient.medicalAlert ? (
          <div style={{
            border: "1px solid #b91c1c",
            backgroundColor: "#fef2f2",
            color: "#991b1b",
            padding: "2mm 3mm",
            borderRadius: "2mm",
            fontSize: "8.5pt",
            fontWeight: 700,
            marginTop: "2mm",
            display: "flex",
            alignItems: "center",
            gap: "2mm"
          }}>
            <span>⚠️ تنبيه طبي للمريض:</span>
            <span>{patient.medicalAlert}</span>
          </div>
        ) : null}

        {stored.status === "void" ? (
          <div style={{
            border: "2px solid #b91c1c",
            backgroundColor: "#fef2f2",
            color: "#991b1b",
            padding: "2mm 3mm",
            borderRadius: "2mm",
            fontSize: "10pt",
            fontWeight: 900,
            textAlign: "center",
            marginTop: "2mm",
          }}>
            وصفة مُبطلة — لا تُصرف منها ({stored.voidReason}) · VOIDED
          </div>
        ) : null}

        {diagnosisText ? (
          <div className="line" style={{ marginTop: "2.5mm", fontSize: "9pt" }}>
            <span style={{ color: "#475569" }}>التشخيص الطبي:</span>
            <span style={{ fontWeight: 700 }}>{diagnosisText}</span>
          </div>
        ) : null}

        <div className="rule" />

        {/* علامة Rx وقائمة الأدوية */}
        <div style={{ display: "flex", alignItems: "center", gap: "2mm", margin: "2mm 0" }}>
          <span style={{
            fontSize: "18pt",
            fontFamily: "serif",
            fontWeight: 900,
            fontStyle: "italic",
            color: "#0d2137"
          }}>
            ℞
          </span>
          <span style={{ fontSize: "8.5pt", color: "#64748b", fontWeight: 600 }}>
            الوصفة العلاجية والجرعات · <span dir="ltr">Prescription &amp; Dosage</span>
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "3mm" }} dir="ltr">
          {rxItems.map((item, idx) => {
            const ar = (item.instructions ?? "").trim();
            const en = (item.instructionsEn ?? "").trim();
            const showAr = lang !== "en" && ar;
            const showEn = lang !== "ar" && en;
            return (
              <div
                key={idx}
                style={{
                  borderBottom: "1px dashed #cbd5e1",
                  paddingBottom: "2.5mm",
                  fontSize: "9pt",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "2mm" }}>
                    <span style={{ fontWeight: 800, color: "#0f172a", fontSize: "10pt" }}>
                      {idx + 1}. {item.name}
                    </span>
                    {item.dose && (
                      <span style={{ color: "#0369a1", fontWeight: 700, fontSize: "9pt" }}>
                        ({item.dose})
                      </span>
                    )}
                    {item.form && (
                      <span style={{ color: "#64748b", fontSize: "8pt" }}>
                        — {item.form}
                      </span>
                    )}
                  </div>
                  {item.duration && (
                    <span style={{ color: "#475569", fontSize: "8pt", fontWeight: 600 }}>
                      {item.duration}
                    </span>
                  )}
                </div>

                {item.frequency && (
                  <div style={{ marginTop: "1mm", fontSize: "8.5pt", color: "#334155" }}>
                    💊 {item.frequency}
                  </div>
                )}

                {(showAr || showEn) && (
                  <div style={{ marginTop: "1mm", display: "grid", gap: "0.8mm" }}>
                    {showAr && (
                      <div style={{ fontSize: "8.5pt", color: "#475569" }} dir="rtl">
                        <span style={{ fontWeight: 700 }}>التعليمات: </span>
                        {ar}
                      </div>
                    )}
                    {showEn && (
                      <div style={{ fontSize: "8.5pt", color: "#475569", fontStyle: "italic" }}>
                        <span style={{ fontWeight: 700, fontStyle: "normal" }}>Instructions: </span>
                        {en}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {notesText && (
          <div style={{ marginTop: "3mm", fontSize: "8pt", color: "#475569", lineHeight: "1.5" }}>
            <span style={{ fontWeight: 700 }}>إرشادات إضافية: </span>
            <span>{notesText}</span>
          </div>
        )}

        <div className="sign-row" style={{ marginTop: "12mm", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: "8pt", color: "#64748b" }}>الطبيب المعالج · <span dir="ltr">Physician</span></div>
            <div style={{ fontWeight: 800, fontSize: "9pt", marginTop: "1mm" }}>
              <bdi>{stored.prescribingDoctorName || "اسم الطبيب غير موثق في الوصفة المحفوظة"}</bdi>
            </div>
            <div style={{ fontSize: "7.5pt", color: "#94a3b8" }}>طب وجراحة الفم والأسنان · <span dir="ltr">Oral Medicine &amp; Dental Surgery</span></div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "8pt", color: "#64748b" }}>التوقيع والختم · <span dir="ltr">Signature &amp; Stamp</span></div>
            <div style={{ height: "10mm", width: "30mm", borderBottom: "1px dotted #94a3b8", margin: "2mm auto 0" }} />
          </div>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
