import "./prescription.css";
import { canPrintSavedPrescription } from "@/lib/prescription-print-access";
import { notFound } from "next/navigation";
import { getPatient, getPrescription, getPrescriptionPrintSettings } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { ageFromBirthYear, ageText, GENDER_LABEL } from "@/lib/patient";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

type InstructionsLang = "both" | "ar" | "en";

function parseInstructionsLang(value: string | undefined): InstructionsLang {
  if (value === "ar" || value === "en") return value;
  return "both";
}

/**
 * الوصفة والروشتة الطبية السنية — مقاس A6 (ربع A4)، مع صفحات متابعة عند الحاجة.
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
  searchParams: Promise<{
    rx?: string | string[];
    draft?: string | string[];
    items?: string | string[];
    diagnosis?: string | string[];
    notes?: string | string[];
    doctorName?: string; // Historical metadata is ignored; saved snapshot wins.
    doctorPartyId?: string;
    date?: string;
    lang?: string;
  }>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  /* Existing clinicians and explicitly granted reception reprints; patient
     scope and stored-only reception restrictions are checked independently. */
  if (!await canPrintSavedPrescription(session)) notFound();

  const { id: rawId } = await params;
  const patientId = Number(rawId);
  if (!Number.isSafeInteger(patientId) || patientId <= 0) notFound();

  const sParams = await searchParams;
  // Reject legacy draft/clinical payloads, even alongside a valid saved ID.
  // Other historical query metadata is ignored; the saved snapshot is authoritative.
  if (["draft", "items", "diagnosis", "notes"].some(key => Object.prototype.hasOwnProperty.call(sParams, key))
    || typeof sParams.rx !== "string" || !/^\d+$/.test(sParams.rx)) notFound();
  const storedRx = Number(sParams.rx);
  if (!Number.isSafeInteger(storedRx) || storedRx <= 0) notFound();

  if (!(await canAccessPatient(session, patientId).catch(() => false))) notFound();

  const [patient, settings] = await Promise.all([
    getPatient(patientId),
    getPrescriptionPrintSettings(),
  ]);

  if (!patient) notFound();

  /* الوصفة المحفوظة (من مستودع الوكيل الآخر): تُطبَع من السجل كما صدرت —
   * فما طُبِع يُخزّن كما طُبِع، والإبطال وحده يغيّر شيئًا (بسببٍ موثّق). */
  const stored = await getPrescription(storedRx);
  if (!stored || stored.patientId !== patientId) notFound();
  // Reception receives only an active stored record.
  if (session.role === "reception" && stored.status !== "active") notFound();

  const rxItems = stored.items;
  const lang = parseInstructionsLang(stored.instructionsLang);
  const diagnosisText = stored.diagnosis;
  const notesText = stored.notes;
  const dateStr = stored.createdAt.slice(0, 10);
  const age = ageFromBirthYear(patient.birthYear, dateStr);
  const prescribingDoctorName = stored.prescribingDoctorName || "اسم الطبيب غير موثق في الوصفة القديمة";

  return (
    <>
      <PrintButton docType="prescription" docId={stored.id} patientId={patientId} />
      <div className="sheet sheet-a6 prescription-a6-sheet">
        <PrintHeader settings={settings} title="وصفة طبية (روشتة)" compact strictIdentity />

        <div className="prescription-context" dir="rtl">
          <span>العمر / الجنس: {ageText(age)} · {GENDER_LABEL[patient.gender]}</span>
          <span>التاريخ: {friendlyDateLong(dateStr)}</span>
        </div>
        <table className="prescription-pages"><thead><tr><td>
          {/* Compact identity repeats; the full metadata block exceeded the
              browser's repeating-header height budget on A6. */}
          <div className="prescription-page-identity">
            <div>المريض: <bdi style={{ fontWeight: 800 }}>{patient.fullName}</bdi> · رقم الملف: <bdi>{patient.patientNumber}</bdi></div>
            <div>الطبيب: <bdi>{prescribingDoctorName}</bdi> · <bdi>{`Rx #${stored.id}`}</bdi></div>
          </div>
        </td></tr></thead><tbody dir="ltr" data-prescription-body="ltr" style={{ textAlign: "left" }}><tr><td>

        {/* تنبيه الحساسية والأمراض المزمنة */}
        {patient.medicalAlert ? (
          <div dir="rtl" style={{
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

        {/* التشخيص إن وُجد */}
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
          <div className="line" style={{ marginTop: "1mm", fontSize: "9pt" }}>
            <span style={{ color: "#475569" }}>التشخيص الطبي:</span>
            <span dir="auto" style={{ fontWeight: 700 }}>{diagnosisText}</span>
          </div>
        ) : null}

        <div className="rule" />

        {/* The document title already identifies the prescription; omit the
            redundant decorative Rx banner rather than shrinking clinical text. */}
        </td></tr>
          {rxItems.map((item, idx) => {
            const ar = (item.instructions ?? "").trim();
            const en = (item.instructionsEn ?? "").trim();
            const showAr = lang !== "en" && ar;
            const showEn = lang !== "ar" && en;
            return (
              <tr key={idx} className="prescription-medication"><td>
              <div style={{
                  borderBottom: "1px dashed #cbd5e1",
                  paddingBottom: "2.5mm",
                  fontSize: "9pt",
                }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: "1mm", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", minWidth: 0, alignItems: "baseline", gap: "2mm" }}>
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

                {item.selection?.amount && <p dir="ltr" className="mt-1 text-sm">Dose: {item.selection.amount}</p>}
                {item.frequency && (
                  <div style={{ marginTop: "1mm", fontSize: "8.5pt", color: "#334155" }}>
                    💊 {item.frequency}
                  </div>
                )}

                {(showAr || showEn) && (
                  <div style={{ marginTop: "1mm", display: "grid", gap: "0.8mm" }}>
                    {showAr && (
                      <div style={{ fontSize: "8.5pt", color: "#475569", textAlign: "right" }} dir="rtl">
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
              </td></tr>
            );
          })}
        <tr className="prescription-ending"><td>
        {notesText && (
          <div dir="auto" style={{ marginTop: "3mm", fontSize: "8pt", color: "#475569", lineHeight: "1.5" }}>
            <span style={{ fontWeight: 700 }}>إرشادات إضافية: </span>
            <span>{notesText}</span>
          </div>
        )}

        <div className="sign-row" dir="ltr" style={{ textAlign: "left", marginTop: "4mm", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: "8pt", color: "#64748b" }}><span dir="ltr">Physician</span> · <span dir="rtl">الطبيب المعالج</span></div>
            <div style={{ fontWeight: 800, fontSize: "9pt", marginTop: "1mm" }}>
              <bdi>{prescribingDoctorName}</bdi>
            </div>

          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "8pt", color: "#64748b" }}>التوقيع والختم · <span dir="ltr">Signature &amp; Stamp</span></div>
            <div style={{ height: "10mm", width: "30mm", borderBottom: "1px dotted #94a3b8", margin: "2mm auto 0" }} />
          </div>
        </div>

        <PrintFooter settings={settings} strictIdentity />
        </td></tr></tbody></table>
      </div>
    </>
  );
}


