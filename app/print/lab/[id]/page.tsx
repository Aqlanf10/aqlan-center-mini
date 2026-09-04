import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getLabOrderById, getPatient, getSettingsSafe } from "@/lib/db";
import { ageFromBirthYear, ageText, GENDER_LABEL } from "@/lib/patient";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import {
  LAB_IMPRESSION_LABEL,
  LAB_PRIORITY_LABEL,
  LAB_TOOTH_ROLE_META,
  parseLabTeeth,
  summarizeLabTeeth,
  type LabToothRole,
} from "@/lib/lab";
import { toothName } from "@/lib/dental";

export const dynamic = "force-dynamic";

/**
 * تذكرة إرسالية معمل تركيبات الأسنان الرسمية — مقاس A4 / A5 قياسي.
 *
 * وثيقة رسمية ترافق الطبعات السريرية أو النماذج الرقمية المرسلة إلى فني
 * ومختبر الأسنان، متضمنة أرقام الأسنان بدقة، درجات لون الخزف ولون الجذع،
 * ومواصفات الإطباق والحدود، مع رمز QR للمطابقة وسند استلام مندوب المعمل.
 */
export default async function LabOrderPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  if (!session) notFound();

  const { id: rawId } = await params;
  const orderId = Number(rawId);
  if (!Number.isInteger(orderId) || orderId <= 0) notFound();

  const order = await getLabOrderById(orderId);
  if (!order) notFound();

  const [patient, settings] = await Promise.all([
    getPatient(order.patientId),
    getSettingsSafe(),
  ]);

  const toothMap = parseLabTeeth(order.toothNumbers);
  const toothSummary = summarizeLabTeeth(toothMap);
  const selectedTeethCodes = Object.keys(toothMap).map(Number).sort((a, b) => a - b);

  // توليد رمز QR للطلب
  const qrPayload = JSON.stringify({
    rx: `RX-${order.id}`,
    patient: order.patientName,
    fileNo: order.patientNumber || undefined,
    work: order.workType,
    shade: order.shade || undefined,
    lab: order.labName,
    sent: order.sentDate,
    due: order.dueDate,
    priority: order.priority,
  });

  let qrCodeDataUrl = "";
  try {
    qrCodeDataUrl = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 140,
      color: { dark: "#0f172a", light: "#ffffff" },
    });
  } catch {
    // fallback
  }

  const clinicName = settings["clinic.name"] || "مركز عقلان لطب الأسنان";
  const priorityInfo = LAB_PRIORITY_LABEL[order.priority] || { label: "عادي", badge: "bg-slate-100" };
  const impressionLabel = LAB_IMPRESSION_LABEL[order.impressionType] || "طبعة سيليكون مطاطي";

  const upperTeeth = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
  const lowerTeeth = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

  return (
    <>
      <PrintButton />
      <div
        className="sheet sheet-a4"
        style={{ padding: "10mm 12mm", fontSize: "9.5pt", lineHeight: "1.4" }}
      >
        <PrintHeader
          settings={settings}
          title="تذكرة إرسالية معمل تركيبات وتعويضات الأسنان"
        />
        <div style={{ textAlign: "center", marginTop: "-2mm", marginBottom: "2mm", fontSize: "8pt", color: "#64748b" }}>
          Dental Laboratory Work Authorization Order · RX-{order.id}
        </div>

        {/* شريط البيانات الأساسية */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 100px",
            gap: "3mm",
            backgroundColor: "#f8fafc",
            border: "1.5px solid #cbd5e1",
            borderRadius: "3mm",
            padding: "3mm 4mm",
            marginTop: "3mm",
            fontSize: "9pt",
          }}
        >
          {/* بيانات المريض */}
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5mm" }}>
            <div>
              <span style={{ color: "#64748b", fontWeight: "bold" }}>المريض: </span>
              <strong style={{ fontSize: "10.5pt", color: "#0f172a" }}>{order.patientName}</strong>
            </div>
            <div>
              <span style={{ color: "#64748b" }}>رقم الملف: </span>
              <strong style={{ fontFamily: "monospace", color: "#0369a1" }}>
                {order.patientNumber || "—"}
              </strong>
              {patient && (
                <span style={{ marginRight: "3mm", color: "#475569" }}>
                  ({GENDER_LABEL[patient.gender]}
                  {patient.birthYear ? ` · ${ageText(ageFromBirthYear(patient.birthYear, order.sentDate))}` : ""})
                </span>
              )}
            </div>
            <div>
              <span style={{ color: "#64748b" }}>هاتف المريض: </span>
              <span dir="ltr" style={{ fontWeight: "600" }}>{order.patientPhone || "—"}</span>
            </div>
          </div>

          {/* بيانات الطلب والمختبر */}
          <div style={{ display: "flex", flexDirection: "column", gap: "1.5mm" }}>
            <div>
              <span style={{ color: "#64748b", fontWeight: "bold" }}>المختبر: </span>
              <strong style={{ fontSize: "10.5pt", color: "#0f172a" }}>{order.labName}</strong>
              {order.labPhone && <span dir="ltr" style={{ marginRight: "2mm", fontSize: "8pt", color: "#64748b" }}>({order.labPhone})</span>}
            </div>
            <div>
              <span style={{ color: "#64748b" }}>الطبيب المعالج: </span>
              <strong style={{ color: "#334155" }}>{order.doctorName || "د. عقلان الكامل"}</strong>
            </div>
            <div style={{ display: "flex", gap: "3mm", alignItems: "center" }}>
              <div>
                <span style={{ color: "#64748b" }}>تاريخ الإرسال: </span>
                <strong style={{ color: "#0f172a" }}>{order.sentDate}</strong>
              </div>
              <div>
                <span style={{ color: "#64748b" }}>التسليم المطلوب: </span>
                <strong style={{ color: "#b91c1c" }}>{order.dueDate}</strong>
              </div>
            </div>
          </div>

          {/* باركود QR ودرجة الأولوية */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            {qrCodeDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrCodeDataUrl} alt="QR Code" style={{ width: "65px", height: "65px", borderRadius: "4px" }} />
            ) : null}
            <span
              style={{
                marginTop: "1.5mm",
                padding: "1mm 2.5mm",
                borderRadius: "3mm",
                fontSize: "7.5pt",
                fontWeight: "900",
                backgroundColor: order.priority === "rush" || order.priority === "urgent" ? "#fee2e2" : "#f1f5f9",
                color: order.priority === "rush" || order.priority === "urgent" ? "#991b1b" : "#334155",
                border: "1px solid currentColor",
              }}
            >
              {priorityInfo.label}
            </span>
          </div>
        </div>

        {/* جدول المواصفات الفنية للعمل */}
        <div style={{ marginTop: "4mm" }}>
          <h3 style={{ fontSize: "10pt", fontWeight: "900", color: "#0f172a", marginBottom: "1.5mm" }}>
            المواصفات الفنية للتعويضات السنية
          </h3>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              border: "1px solid #cbd5e1",
              fontSize: "9pt",
            }}
          >
            <tbody>
              <tr style={{ backgroundColor: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <td style={{ padding: "2.5mm 3mm", fontWeight: "bold", width: "22%", color: "#475569" }}>
                  نوع العمل والتركيبة:
                </td>
                <td style={{ padding: "2.5mm 3mm", fontWeight: "900", fontSize: "10pt", color: "#0369a1" }}>
                  {order.workType}
                </td>
                <td style={{ padding: "2.5mm 3mm", fontWeight: "bold", width: "18%", color: "#475569" }}>
                  نوع الطبعة:
                </td>
                <td style={{ padding: "2.5mm 3mm", fontWeight: "bold", color: "#334155" }}>
                  {impressionLabel}
                </td>
              </tr>
              <tr style={{ borderBottom: "1px solid #e2e8f0" }}>
                <td style={{ padding: "2.5mm 3mm", fontWeight: "bold", color: "#475569" }}>
                  لون الخزف (Body Shade):
                </td>
                <td style={{ padding: "2.5mm 3mm", fontWeight: "900", fontSize: "11pt", color: "#0f172a" }}>
                  {order.shade ? (
                    <span style={{ padding: "1mm 3mm", backgroundColor: "#fef3c7", border: "1px solid #f59e0b", borderRadius: "3px" }}>
                      {order.shade}
                    </span>
                  ) : (
                    "حسب تقدير الفني / غير محدد"
                  )}
                </td>
                <td style={{ padding: "2.5mm 3mm", fontWeight: "bold", color: "#475569" }}>
                  لون الجذع (Stump Shade):
                </td>
                <td style={{ padding: "2.5mm 3mm", fontWeight: "bold", color: "#334155" }}>
                  {order.stumpShade ? (
                    <span style={{ padding: "1mm 2.5mm", backgroundColor: "#f1f5f9", borderRadius: "3px" }}>
                      {order.stumpShade}
                    </span>
                  ) : (
                    "طبيعي"
                  )}
                </td>
              </tr>
              <tr style={{ borderBottom: "1px solid #e2e8f0" }}>
                <td style={{ padding: "2.5mm 3mm", fontWeight: "bold", color: "#475569" }}>
                  الأسنان المشمولة (FDI):
                </td>
                <td colSpan={3} style={{ padding: "2.5mm 3mm", fontWeight: "900", color: "#0f172a" }}>
                  {selectedTeethCodes.length > 0 ? (
                    <div style={{ display: "flex", gap: "2mm", flexWrap: "wrap", alignItems: "center" }}>
                      {selectedTeethCodes.map((code) => {
                        const role = toothMap[code] || "crown";
                        const meta = LAB_TOOTH_ROLE_META[role];
                        return (
                          <span
                            key={code}
                            style={{
                              padding: "1mm 2.5mm",
                              backgroundColor: "#e0f2fe",
                              border: "1px solid #38bdf8",
                              borderRadius: "4px",
                              fontSize: "9pt",
                            }}
                          >
                            <strong>#{code}</strong> ({meta?.label || "تاج"})
                          </span>
                        );
                      })}
                      <span style={{ fontSize: "8pt", color: "#64748b", marginRight: "2mm" }}>
                        (الإجمالي: {selectedTeethCodes.length} أسنان)
                      </span>
                    </div>
                  ) : (
                    order.toothNumbers || "كامل الفك / عام"
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* المخطط السني المرئي المبسط للطباعة */}
        <div
          style={{
            marginTop: "4mm",
            padding: "3mm",
            border: "1px solid #cbd5e1",
            borderRadius: "3mm",
            backgroundColor: "#f8fafc",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2mm" }}>
            <span style={{ fontWeight: "bold", fontSize: "8.5pt", color: "#334155" }}>
              مخطط الأسنان السريري لترتيب الجسور والتيجان (FDI Two-Digit Chart)
            </span>
            <span style={{ fontSize: "7.5pt", color: "#64748b" }}>
              الأسنان المحددة موضحة بلون مميز
            </span>
          </div>

          {/* الفك العلوي */}
          <div style={{ display: "flex", justifyContent: "center", gap: "1mm", marginBottom: "1.5mm" }}>
            {upperTeeth.map((tooth) => {
              const isSelected = toothMap[tooth] !== undefined;
              return (
                <div
                  key={tooth}
                  style={{
                    width: "20px",
                    height: "22px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "7.5pt",
                    fontWeight: isSelected ? "900" : "500",
                    backgroundColor: isSelected ? "#0284c7" : "#ffffff",
                    color: isSelected ? "#ffffff" : "#64748b",
                    border: isSelected ? "1.5px solid #0369a1" : "1px solid #cbd5e1",
                    borderRadius: "3px",
                  }}
                >
                  {tooth}
                </div>
              );
            })}
          </div>

          {/* خط منتصف الإطباق */}
          <div style={{ height: "1px", backgroundColor: "#cbd5e1", margin: "1mm auto", width: "90%" }} />

          {/* الفك السفلي */}
          <div style={{ display: "flex", justifyContent: "center", gap: "1mm", marginTop: "1.5mm" }}>
            {lowerTeeth.map((tooth) => {
              const isSelected = toothMap[tooth] !== undefined;
              return (
                <div
                  key={tooth}
                  style={{
                    width: "20px",
                    height: "22px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "7.5pt",
                    fontWeight: isSelected ? "900" : "500",
                    backgroundColor: isSelected ? "#0284c7" : "#ffffff",
                    color: isSelected ? "#ffffff" : "#64748b",
                    border: isSelected ? "1.5px solid #0369a1" : "1px solid #cbd5e1",
                    borderRadius: "3px",
                  }}
                >
                  {tooth}
                </div>
              );
            })}
          </div>
        </div>

        {/* تعليمات وتفاصيل الطبيب المعالج */}
        <div style={{ marginTop: "4mm" }}>
          <h3 style={{ fontSize: "10pt", fontWeight: "900", color: "#0f172a", marginBottom: "1.5mm" }}>
            تعليمات وتوجيهات الطبيب المعالج لفني المختبر:
          </h3>
          <div
            style={{
              padding: "3.5mm 4mm",
              backgroundColor: "#ffffff",
              border: "1.5px solid #cbd5e1",
              borderRadius: "3mm",
              minHeight: "22mm",
              fontSize: "9.5pt",
              lineHeight: "1.5",
              color: "#1e293b",
            }}
          >
            {order.details ? (
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{order.details}</p>
            ) : (
              <p style={{ margin: 0, color: "#94a3b8", fontStyle: "italic" }}>
                يرجى الالتزام بالتشريح الطبيعي، ومراعاة نقاط التماس المتقاربة (Tight Proximal Contacts)،
                والإطباق الخفيف (Light Centric Occlusion) بدون أي إعاقة حركية.
              </p>
            )}
          </div>
        </div>

        {/* توقيعات الطبيب ومندوب المعمل */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "5mm",
            marginTop: "6mm",
            paddingTop: "4mm",
            borderTop: "1px dashed #cbd5e1",
          }}
        >
          {/* توقيع الطبيب المعالج */}
          <div
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: "2mm",
              padding: "3mm",
              backgroundColor: "#f8fafc",
            }}
          >
            <p style={{ fontWeight: "bold", fontSize: "8.5pt", color: "#334155", margin: 0 }}>
              توقيع وختم الطبيب المعالج:
            </p>
            <div style={{ height: "14mm" }} />
            <div style={{ borderTop: "1px solid #cbd5e1", paddingTop: "1mm", fontSize: "8pt", color: "#64748b" }}>
              {order.doctorName || "د. عقلان الكامل"} · التاريخ: {order.sentDate}
            </div>
          </div>

          {/* إشعار استلام مندوب المختبر */}
          <div
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: "2mm",
              padding: "3mm",
              backgroundColor: "#f8fafc",
            }}
          >
            <p style={{ fontWeight: "bold", fontSize: "8.5pt", color: "#334155", margin: 0 }}>
              إقرار استلام مندوب المعمل:
            </p>
            <div style={{ height: "14mm" }} />
            <div style={{ borderTop: "1px solid #cbd5e1", paddingTop: "1mm", fontSize: "8pt", color: "#64748b" }}>
              اسم المستلم: ............................... التوقيع: .....................
            </div>
          </div>
        </div>

        <div style={{ marginTop: "3mm", textAlign: "center", fontSize: "7.5pt", color: "#64748b", fontStyle: "italic" }}>
          * يُعاد إرسال هذه التذكرة مع العمل المنجز لمطابقتها سريرياً قبل التسليم النهائي للمريض.
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
