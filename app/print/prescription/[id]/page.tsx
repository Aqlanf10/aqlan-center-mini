import { notFound } from "next/navigation";
import { getPatient, getPrescription, getSettingsSafe } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { isAdmin } from "@/lib/roles";
import { sanitizeRxItems } from "@/lib/prescription";
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
    items?: string;
    notes?: string;
    date?: string;
    lang?: string;
    /** رقم وصفةٍ محفوظة (من مستودع الوكيل الآخر) — طباعة الوثيقة كما صدرت. */
    rx?: string;
    /** وضع المسودة: معاينة غير معتمدة بعلامة مائية — ليست وصفة صرف. */
    draft?: string;
  }>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  /* وثيقة سريرية رسمية: مستخدمٌ سريري (طبيب، أو مدير) لا استقبال — ومن يفتحها
     يملك المريض (P0.9): الطبيب A لا يطبع وصفة مريض الطبيب B. */
  if (!isAdmin(session.role) && session.role !== "doctor") notFound();

  const { id: rawId } = await params;
  const patientId = Number(rawId);
  if (!Number.isInteger(patientId) || patientId <= 0) notFound();

  const sParams = await searchParams;

  if (!(await canAccessPatient(session, patientId).catch(() => false))) notFound();

  const [patient, settings] = await Promise.all([
    getPatient(patientId),
    getSettingsSafe(),
  ]);

  if (!patient) notFound();

  /* الوصفة المحفوظة (من مستودع الوكيل الآخر): تُطبَع من السجل كما صدرت —
   * فما طُبِع يُخزّن كما طُبِع، والإبطال وحده يغيّر شيئًا (بسببٍ موثّق). */
  const storedRx = Number(sParams.rx);
  const stored = Number.isInteger(storedRx) && storedRx > 0
    ? await getPrescription(storedRx) : null;
  if (sParams.rx && !stored) notFound();
  if (stored && stored.patientId !== patientId) notFound();

  /* الوثيقة الرسمية تُطبع من السجل المحفوظ كما صدرت — وما لم يُحفظ فلا وصفة:
   * صفحةٌ بلا وصفةٍ محفوظة لا تطبع أدوية «مثالًا» لم يصفها أحد (P0.9)، ولا
   * يُطبع اسم طبيبٍ من معاملات الرابط. المسودة المعزولة (?draft=1) وحدها
   * تعرض بياناتٍ مرسلة — منقّاة، وبعلامة «غير معتمدة» لا تصرف بها صيدلية. */
  const isDraftMode = !stored && sParams.draft === "1" && typeof sParams.items === "string";

  let rxItems: RxItem[] = [];
  if (stored) {
    rxItems = stored.items;
  } else if (isDraftMode) {
    try {
      rxItems = sanitizeRxItems(JSON.parse(decodeURIComponent(sParams.items!)));
    } catch {
      rxItems = [];
    }
  }
  if (!stored && !isDraftMode) notFound(); // لا وصفة محفوظة ولا مسودة معلنة: لا ورقة
  if (isDraftMode && rxItems.length === 0) notFound(); // مسودة بلا أدوية صالحة: لا ورقة

  const lang = parseInstructionsLang(stored ? stored.instructionsLang : sParams.lang);
  const diagnosisText = stored ? stored.diagnosis : isDraftMode ? sParams.diagnosis : null;
  const notesText = stored ? stored.notes : isDraftMode ? sParams.notes : null;
  const now = new Date();
  const dateStr = stored
    ? stored.createdAt.slice(0, 10)
    : isDraftMode
      ? sParams.date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const age = ageFromBirthYear(patient.birthYear, dateStr);

  return (
    <>
      {stored ? <PrintButton docType="prescription" docId={stored.id} /> : null}
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
        {isDraftMode ? (
          <div style={{
            border: "2px dashed #b45309",
            backgroundColor: "#fffbeb",
            color: "#92400e",
            padding: "2mm 3mm",
            borderRadius: "2mm",
            fontSize: "10pt",
            fontWeight: 900,
            textAlign: "center",
            marginTop: "2mm",
          }}>
            مسودة غير معتمدة — لا تُصرف من الصيدلية · UNAPPROVED DRAFT
          </div>
        ) : null}

        {stored?.status === "void" ? (
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
              {stored ? stored.createdBy : session.username}
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
