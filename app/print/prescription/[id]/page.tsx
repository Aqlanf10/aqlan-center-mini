import { notFound } from "next/navigation";
import { getPatient, getSettingsSafe } from "@/lib/db";
import { ageFromBirthYear, ageText, GENDER_LABEL } from "@/lib/patient";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

interface RxItem {
  name: string;
  dose?: string; // 500mg, 1g
  form?: string; // Tablets, Capsules, Syrup, Mouthwash, Ointment — English
  frequency?: string; // 1 tablet every 8 hours — English
  duration?: string; // 5 days — English
  instructions?: string; // تعليمات المريض بالعربية
  instructionsEn?: string; // patient instructions in English
}

type InstructionsLang = "both" | "ar" | "en";

function parseInstructionsLang(value: string | undefined): InstructionsLang {
  if (value === "ar" || value === "en") return value;
  return "both";
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
  searchParams: Promise<{
    diagnosis?: string;
    doctorName?: string;
    items?: string;
    notes?: string;
    date?: string;
    lang?: string;
  }>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  const { id: rawId } = await params;
  const patientId = Number(rawId);
  if (!Number.isInteger(patientId) || patientId <= 0) notFound();

  const sParams = await searchParams;

  const [patient, settings] = await Promise.all([
    getPatient(patientId),
    getSettingsSafe(),
  ]);

  if (!patient) notFound();

  let rxItems: RxItem[] = [];
  if (sParams.items) {
    try {
      rxItems = JSON.parse(decodeURIComponent(sParams.items));
    } catch {
      // fallback if simple string or comma-separated
      rxItems = sParams.items.split(";").map((item) => {
        const parts = item.split("|");
        return {
          name: parts[0] || item,
          dose: parts[1] || "",
          frequency: parts[2] || "",
          duration: parts[3] || "",
          instructions: parts[4] || "",
        };
      });
    }
  }

  // Default sample if opened empty
  if (rxItems.length === 0) {
    rxItems = [
      {
        name: "Amoxicillin + Clavulanic acid (Augmentin)",
        form: "Tablets",
        dose: "1g",
        frequency: "1 tablet every 12 hours",
        duration: "5 days",
        instructions: "بعد الأكل مباشرة مع كمية كافية من الماء",
        instructionsEn: "Take right after food with plenty of water",
      },
      {
        name: "Ibuprofen (Brufen)",
        form: "Tablets",
        dose: "400mg",
        frequency: "1 tablet every 8 hours",
        duration: "3 days / as needed",
        instructions: "بعد الطعام لتسكين الألم",
        instructionsEn: "After meals for pain relief",
      },
      {
        name: "Chlorhexidine Mouthwash 0.12%",
        form: "Mouthwash",
        dose: "15ml",
        frequency: "Twice daily",
        duration: "7 days",
        instructions: "مضمضة لمدة دقيقة — لا أكل ولا شرب بعدها لـ 30 دقيقة",
        instructionsEn: "Rinse for one minute; no food or drink for 30 minutes after",
      },
    ];
  }

  const lang = parseInstructionsLang(sParams.lang);

  const now = new Date();
  const dateStr = sParams.date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const age = ageFromBirthYear(patient.birthYear, dateStr);

  return (
    <>
      <PrintButton docType="statement" docId={patientId} />
      <div className="sheet sheet-a5">
        <PrintHeader settings={settings} title="وصفة طبية (روشتة)" compact />

        {/* معلومات المريض */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2mm", fontSize: "9pt", marginTop: "1mm" }}>
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
        </div>

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

        {/* التشخيص إن وُجد */}
        {sParams.diagnosis ? (
          <div className="line" style={{ marginTop: "2.5mm", fontSize: "9pt" }}>
            <span style={{ color: "#475569" }}>التشخيص الطبي:</span>
            <span style={{ fontWeight: 700 }}>{sParams.diagnosis}</span>
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

        {sParams.notes && (
          <div style={{ marginTop: "3mm", fontSize: "8pt", color: "#475569", lineHeight: "1.5" }}>
            <span style={{ fontWeight: 700 }}>إرشادات إضافية: </span>
            <span>{sParams.notes}</span>
          </div>
        )}

        <div className="sign-row" style={{ marginTop: "12mm", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: "8pt", color: "#64748b" }}>الطبيب المعالج · <span dir="ltr">Physician</span></div>
            <div style={{ fontWeight: 800, fontSize: "9pt", marginTop: "1mm" }}>
              {sParams.doctorName || session.username}
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
