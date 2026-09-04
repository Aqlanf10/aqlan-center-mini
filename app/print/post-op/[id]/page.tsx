import { notFound } from "next/navigation";
import { getPatient, getSettingsSafe } from "@/lib/db";
import { ageFromBirthYear, ageText, GENDER_LABEL } from "@/lib/patient";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import {
  POST_OP_TEMPLATES,
  getPostOpTemplate,
  type PostOpTemplate,
} from "@/lib/post-op-care";

export const dynamic = "force-dynamic";

interface PostOpSearchParams {
  templateId?: string;
  notes?: string;
  date?: string;
}

/**
 * بطاقة إرشادات العناية المنزلية ما بعد العلاج السني — مقاس A5 قياسي.
 *
 * وثيقة مطبوعة يتسلمها المريض عند مغادرة العيادة توضح التعليمات الصحية
 * الدقيقة والمأكولات المسموحة والممنوعة وهواتف الطوارئ السريعة.
 */
export default async function PostOpPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<PostOpSearchParams>;
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

  const templateId = sParams.templateId || "surgical_extraction";
  const template: PostOpTemplate =
    getPostOpTemplate(templateId) ?? POST_OP_TEMPLATES[0];

  const now = new Date();
  const dateStr =
    sParams.date ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const age = ageFromBirthYear(patient.birthYear, dateStr);

  return (
    <>
      <PrintButton />
      <div
        className="sheet sheet-a5"
        style={{ padding: "7mm 9mm", fontSize: "8.5pt", lineHeight: "1.35" }}
      >
        <PrintHeader
          settings={settings}
          title="إرشادات وتعليمات العناية ما بعد المعالجة السنية"
          compact
        />

        {/* بيانات المريض */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.2fr 0.8fr 1fr 1fr",
            gap: "2mm",
            backgroundColor: "#f8fafc",
            border: "1px solid #cbd5e1",
            borderRadius: "2mm",
            padding: "2mm 3mm",
            marginTop: "2mm",
            fontSize: "8pt",
          }}
        >
          <div>
            <span style={{ color: "#64748b" }}>المريض: </span>
            <strong style={{ color: "#0f172a" }}>{patient.fullName}</strong>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>الملف: </span>
            <span className="num" dir="ltr" style={{ fontWeight: 800 }}>
              {patient.patientNumber}
            </span>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>العمر/الجنس: </span>
            <span>
              {ageText(age)} · {GENDER_LABEL[patient.gender]}
            </span>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>التاريخ: </span>
            <span>{friendlyDateLong(dateStr)}</span>
          </div>
        </div>

        {/* عنوان الإجراء الطبي */}
        <div
          style={{
            margin: "2.5mm 0 2mm",
            borderBottom: "1.5px solid #0f172a",
            paddingBottom: "1.5mm",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: "10.5pt", fontWeight: 900, color: "#0f172a" }}>
            {template.title} ({template.procedureName})
          </span>
          <span style={{ fontSize: "7.5pt", color: "#0284c7", fontWeight: 700 }}>
            كود الإجراء: {template.id}
          </span>
        </div>

        {/* الساعات الـ 24 الأولى */}
        <div style={{ marginTop: "2mm" }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: "8.5pt",
              color: "#0f172a",
              backgroundColor: "#f1f5f9",
              padding: "1mm 2.5mm",
              borderRadius: "1mm",
              marginBottom: "1mm",
            }}
          >
            ⏰ الساعات الـ 24 الأولى (تعليمات أساسية):
          </div>
          <ul style={{ margin: 0, paddingRight: "4.5mm", fontSize: "7.5pt", color: "#1e293b" }}>
            {template.first24Hours.map((item, idx) => (
              <li key={idx} style={{ marginBottom: "0.8mm" }}>
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* المأكولات والمشروبات */}
        <div style={{ marginTop: "2mm" }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: "8.5pt",
              color: "#047857",
              backgroundColor: "#ecfdf5",
              borderRight: "2.5px solid #10b981",
              padding: "1mm 2.5mm",
              marginBottom: "1mm",
            }}
          >
            🍲 المأكولات والمشروبات:
          </div>
          <div style={{ fontSize: "7.5pt", color: "#334155", paddingRight: "2mm", display: "grid", gap: "1mm" }}>
            <div>
              <strong style={{ color: "#065f46" }}>✅ المسموح: </strong>
              <span>{template.diet.allowed.join(" · ")}</span>
            </div>
            <div>
              <strong style={{ color: "#991b1b" }}>❌ الممنوع: </strong>
              <span>{template.diet.avoid.join(" · ")}</span>
            </div>
          </div>
        </div>

        {/* نظافة الفم والأدوية */}
        <div style={{ marginTop: "2mm" }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: "8.5pt",
              color: "#0369a1",
              backgroundColor: "#f0f9ff",
              borderRight: "2.5px solid #0284c7",
              padding: "1mm 2.5mm",
              marginBottom: "1mm",
            }}
          >
            🪥 نظافة الفم ومسكنات الألم:
          </div>
          <ul style={{ margin: 0, paddingRight: "4.5mm", fontSize: "7.5pt", color: "#334155" }}>
            {template.hygiene.concat(template.medications).map((item, idx) => (
              <li key={idx} style={{ marginBottom: "0.8mm" }}>
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* علامات الخطر ومتى تتصل بالمركز */}
        <div style={{ marginTop: "2mm" }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: "8.5pt",
              color: "#991b1b",
              backgroundColor: "#fff1f2",
              borderRight: "2.5px solid #e11d48",
              padding: "1mm 2.5mm",
              marginBottom: "1mm",
            }}
          >
            🚨 متى تتصل بالمركز فوراً؟
          </div>
          <ul style={{ margin: 0, paddingRight: "4.5mm", fontSize: "7.5pt", color: "#7f1d1d" }}>
            {template.emergencyWarnings.map((item, idx) => (
              <li key={idx} style={{ marginBottom: "0.8mm" }}>
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* ملاحظات خاصة من الطبيب */}
        {sParams.notes && (
          <div
            style={{
              marginTop: "2mm",
              border: "1px dashed #0f172a",
              backgroundColor: "#fffbeb",
              padding: "1.5mm 3mm",
              borderRadius: "1.5mm",
              fontSize: "7.5pt",
              color: "#78350f",
            }}
          >
            <strong>توجيه خاص من الطبيب المعالج: </strong>
            <span>{sParams.notes}</span>
          </div>
        )}

        {/* التذييل والاتصال */}
        <div
          style={{
            marginTop: "4mm",
            borderTop: "1px solid #cbd5e1",
            paddingTop: "2mm",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "7.5pt",
            color: "#64748b",
          }}
        >
          <div>
            <span>الطبيب المعالج: </span>
            <strong style={{ color: "#0f172a" }}>د. {session.username}</strong>
          </div>
          <div>
            <span>طوارئ واستفسارات المركز: </span>
            <strong style={{ color: "#0f172a" }}>
              {settings["clinic.phone"] || "المركز الطبي"}
            </strong>
          </div>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
