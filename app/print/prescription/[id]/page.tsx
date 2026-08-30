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
  form?: string; // أقراص، شراب، غسول فم، مرهم، كبسولات
  dose?: string; // 500mg, 1g, الخ
  frequency?: string; // كل 8 ساعات، 3 مرات يومياً بعد الأكل
  duration?: string; // 5 أيام، أسبوع
  instructions?: string; // بعد الأكل، قبل النوم، عند اللزوم
}

/**
 * الوصفة والروشتة الطبية السنية — مقاس A5 قياسي.
 *
 * وثيقة رسمية تصدر باسم المريض بعد الكشف أو الجراحة، متضمنة التشخيص
 * والتنبيهات الطبية (الحساسية والأمراض المزمنة) وجدول الأدوية والجرعات
 * وتوقيع الطبيب المعالج وختم المركز.
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
        form: "أقراص",
        dose: "1g",
        frequency: "قرص كل 12 ساعة",
        duration: "لمدة 5 أيام",
        instructions: "بعد الأكل مباشرة مع كمية كافية من الماء",
      },
      {
        name: "Ibuprofen (Brufen)",
        form: "أقراص",
        dose: "400mg",
        frequency: "قرص كل 8 ساعات",
        duration: "عند اللزوم / 3 أيام",
        instructions: "بعد الطعام لتسكين الألم والالتهاب",
      },
      {
        name: "Chlorhexidine Mouthwash (0.12%)",
        form: "مضمضة فموية",
        dose: "15ml",
        frequency: "مرتان يومياً",
        duration: "لمدة أسبوع",
        instructions: "مضمضة لمدة دقيقة بعد تنظيف الأسنان مع تجنب الأكل لمدة 30 دقيقة",
      },
    ];
  }

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
          <span style={{ fontSize: "8.5pt", color: "#64748b", fontWeight: 600 }}>الوصفة العلاجية والجرعات</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "3mm" }}>
          {rxItems.map((item, idx) => (
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
                      - {item.form}
                    </span>
                  )}
                </div>
                {item.duration && (
                  <span style={{ color: "#475569", fontSize: "8pt", fontWeight: 600 }}>
                    {item.duration}
                  </span>
                )}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "1mm", fontSize: "8.5pt", color: "#334155" }}>
                <span>💊 {item.frequency || "حسب الإرشادات"}</span>
                {item.instructions && (
                  <span style={{ color: "#64748b", fontStyle: "italic" }}>
                    ({item.instructions})
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {sParams.notes && (
          <div style={{ marginTop: "3mm", fontSize: "8pt", color: "#475569", lineHeight: "1.5" }}>
            <span style={{ fontWeight: 700 }}>إرشادات إضافية: </span>
            <span>{sParams.notes}</span>
          </div>
        )}

        <div className="sign-row" style={{ marginTop: "12mm", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: "8pt", color: "#64748b" }}>الطبيب المعالج</div>
            <div style={{ fontWeight: 800, fontSize: "9pt", marginTop: "1mm" }}>
              {sParams.doctorName || session.username}
            </div>
            <div style={{ fontSize: "7.5pt", color: "#94a3b8" }}>طب وجراحة الفم والأسنان</div>
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
