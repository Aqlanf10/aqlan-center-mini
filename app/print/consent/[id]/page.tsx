import { notFound } from "next/navigation";
import { getPatient, getSettingsSafe, getDocumentForDownload } from "@/lib/db";
import { ageFromBirthYear, ageText, GENDER_LABEL } from "@/lib/patient";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import {
  CONSENT_TEMPLATES,
  getConsentTemplate,
  type ConsentTemplate,
} from "@/lib/consent-templates";

export const dynamic = "force-dynamic";

interface ConsentSearchParams {
  docId?: string;
  templateId?: string;
  signatoryName?: string;
  signatoryRelation?: string;
  guardianRelation?: string;
  doctorName?: string;
  date?: string;
}

/**
 * وثيقة الإقرار والموافقة الطبية المستنيرة الرسمية — مقاس A4.
 *
 * وثيقة قانونية وطبية معتمدة تتضمن موافقة المريض أو وليه على الإجراء الجراحي
 * أو العلاجي، مع تفنيد المخاطر، والالتزام بالتعليمات، والتوقيع الرقمي المسجل.
 */
export default async function ConsentPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ConsentSearchParams>;
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

  let documentData: any = null;
  let signatureDocId: number | null = null;
  let parsedNote: any = null;

  if (sParams.docId) {
    const docIdNum = Number(sParams.docId);
    if (Number.isInteger(docIdNum) && docIdNum > 0) {
      const docRes = await getDocumentForDownload(docIdNum).catch(() => null);
      if (docRes && docRes.document && docRes.document.patientId === patientId) {
        documentData = docRes.document;
        signatureDocId = docRes.document.id;
        if (documentData.note) {
          try {
            parsedNote = JSON.parse(documentData.note);
          } catch {
            // ملاحظة نصية عادية
          }
        }
      }
    }
  }

  // تحديد القالب المعتمد
  const templateId =
    sParams.templateId ||
    parsedNote?.templateId ||
    "surgical_extraction";

  const template: ConsentTemplate =
    getConsentTemplate(templateId) ??
    CONSENT_TEMPLATES[0];

  const signatoryName =
    sParams.signatoryName ||
    parsedNote?.signatoryName ||
    patient.fullName;

  const signatoryRelation =
    sParams.signatoryRelation ||
    parsedNote?.signatoryRelation ||
    "self";

  const guardianRelation =
    sParams.guardianRelation ||
    parsedNote?.guardianRelation ||
    "";

  const doctorName =
    sParams.doctorName ||
    session.username;

  const now = new Date();
  const dateStr =
    sParams.date ||
    documentData?.takenOn ||
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const age = ageFromBirthYear(patient.birthYear, dateStr);

  return (
    <>
      <PrintButton />
      <div className="sheet sheet-a4" style={{ padding: "10mm 12mm", fontSize: "9pt", lineHeight: "1.45" }}>
        <PrintHeader
          settings={settings}
          title="إقرار موافقة مستنيرة على إجراء علاجي أو جراحي سني"
          compact
        />

        {/* معلومات المريض والملف الطبي */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.2fr 0.8fr 1fr 1fr",
            gap: "2mm",
            backgroundColor: "#f8fafc",
            border: "1px solid #cbd5e1",
            borderRadius: "2mm",
            padding: "2.5mm 3.5mm",
            marginTop: "3mm",
            fontSize: "8.5pt",
          }}
        >
          <div>
            <span style={{ color: "#64748b" }}>اسم المريض: </span>
            <strong style={{ color: "#0f172a" }}>{patient.fullName}</strong>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>رقم الملف: </span>
            <span className="num" dir="ltr" style={{ fontWeight: 800 }}>
              {patient.patientNumber}
            </span>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>العمر / الجنس: </span>
            <span>
              {ageText(age)} · {GENDER_LABEL[patient.gender]}
            </span>
          </div>
          <div>
            <span style={{ color: "#64748b" }}>تاريخ الإقرار: </span>
            <span>{friendlyDateLong(dateStr)}</span>
          </div>
        </div>

        {/* تنبيه الحساسية إن وُجد */}
        {patient.medicalAlert && (
          <div
            style={{
              border: "1px solid #f87171",
              backgroundColor: "#fef2f2",
              color: "#991b1b",
              padding: "1.5mm 3mm",
              borderRadius: "1.5mm",
              fontSize: "8pt",
              fontWeight: 700,
              marginTop: "2mm",
              display: "flex",
              alignItems: "center",
              gap: "2mm",
            }}
          >
            <span>⚠️ الحالة الصحية وسوابق الحساسية المسجلة: </span>
            <span>{patient.medicalAlert}</span>
          </div>
        )}

        {/* تفاصيل الإجراء الطبي */}
        <div style={{ marginTop: "3.5mm" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              borderBottom: "1.5px solid #0f172a",
              paddingBottom: "1.5mm",
              marginBottom: "2mm",
            }}
          >
            <span style={{ fontSize: "11pt", fontWeight: 900, color: "#0f172a" }}>
              {template.title} ({template.procedureName})
            </span>
            <span style={{ fontSize: "8pt", color: "#64748b", fontWeight: 700 }}>
              كود الإقرار: {template.id}
            </span>
          </div>
          <p style={{ margin: "0 0 3mm", fontSize: "8.5pt", color: "#334155" }}>
            {template.summary}
          </p>
        </div>

        {/* بنود الإقرار والموافقة */}
        <div style={{ marginTop: "2mm" }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: "9pt",
              color: "#0f172a",
              backgroundColor: "#f1f5f9",
              padding: "1mm 2.5mm",
              borderRadius: "1mm",
              marginBottom: "1.5mm",
            }}
          >
            أولاً: الشروط والبنود الطبية المتفق عليها:
          </div>
          <ol
            style={{
              margin: "0",
              paddingRight: "5mm",
              fontSize: "8pt",
              color: "#1e293b",
              display: "grid",
              gap: "1.2mm",
            }}
          >
            {template.terms.map((term, index) => (
              <li key={index} style={{ paddingRight: "1mm" }}>
                {term}
              </li>
            ))}
          </ol>
        </div>

        {/* المخاطر والمضاعفات المحتملة */}
        <div style={{ marginTop: "3mm" }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: "9pt",
              color: "#991b1b",
              backgroundColor: "#fff1f2",
              borderRight: "3px solid #e11d48",
              padding: "1mm 2.5mm",
              marginBottom: "1.5mm",
            }}
          >
            ثانياً: المخاطر والمضاعفات المحتملة المصاحبة للإجراء:
          </div>
          <ul
            style={{
              margin: "0",
              paddingRight: "5mm",
              fontSize: "8pt",
              color: "#334155",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "1.5mm",
            }}
          >
            {template.risks.map((risk, index) => (
              <li key={index} style={{ paddingRight: "1mm" }}>
                {risk}
              </li>
            ))}
          </ul>
        </div>

        {/* تعليمات ما بعد الإجراء ومسؤولية المريض */}
        <div style={{ marginTop: "3mm" }}>
          <div
            style={{
              fontWeight: 800,
              fontSize: "9pt",
              color: "#0369a1",
              backgroundColor: "#f0f9ff",
              borderRight: "3px solid #0284c7",
              padding: "1mm 2.5mm",
              marginBottom: "1.5mm",
            }}
          >
            ثالثاً: تعليمات العناية والتزام المريض بعد الجلسة:
          </div>
          <ul
            style={{
              margin: "0",
              paddingRight: "5mm",
              fontSize: "8pt",
              color: "#334155",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "1.5mm",
            }}
          >
            {template.postOpInstructions.map((care, index) => (
              <li key={index} style={{ paddingRight: "1mm" }}>
                {care}
              </li>
            ))}
          </ul>
        </div>

        {/* نص الإقرار والتعهد القانوني للموقع */}
        <div
          style={{
            border: "1px solid #cbd5e1",
            backgroundColor: "#fafafa",
            borderRadius: "2mm",
            padding: "2.5mm 3.5mm",
            marginTop: "4mm",
            fontSize: "8pt",
            color: "#0f172a",
            textAlign: "justify",
          }}
        >
          <strong style={{ color: "#0f172a" }}>إقرار وتعهد صاحب التوقيع: </strong>
          أقر أنا الموقع أدناه بكامل قواي العقلية وبإرادتي الحرة، بأن الطبيب المعالج قد شرح لي طبيعة الإجراء السني المذكور أعلاه، وفوائده المرجوة، والخيارات العلاجية البديلة، والمضاعفات المحتملة. وقد تم إعطائي الفرصة الكافية لطرح كافة الاستفسارات وتلقيت إجابات وافية ومرضية. وعليه، فإنني أوافق بكامل الرضا على البدء في هذا الإجراء، وأتعهد باتباع التعليمات الطبية والدوائية بدقة.
        </div>

        {/* منطقة التواقيع والاعتماد */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.3fr 0.9fr 1.2fr",
            gap: "4mm",
            marginTop: "5mm",
            borderTop: "1.5px solid #0f172a",
            paddingTop: "3.5mm",
          }}
        >
          {/* توقيع المريض أو الولي */}
          <div>
            <div style={{ fontSize: "8.5pt", fontWeight: 800, color: "#0f172a", marginBottom: "1mm" }}>
              المقر بما فيه ({signatoryRelation === "self" ? "المريض شخصياً" : `الولي / الوصي الشرعي: ${guardianRelation || "صلة قرابة"}`})
            </div>
            <div style={{ fontSize: "8pt", color: "#334155" }}>
              الاسم: <strong>{signatoryName}</strong>
            </div>

            {/* عرض التوقيع الرقمي إن وجد */}
            <div
              style={{
                height: "18mm",
                borderBottom: "1px dotted #94a3b8",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "1.5mm 0",
              }}
            >
              {signatureDocId ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`/api/documents/${signatureDocId}`}
                  alt="التوقيع الرقمي للمقر"
                  style={{ maxHeight: "16mm", maxWidth: "90%", objectFit: "contain" }}
                />
              ) : (
                <span style={{ color: "#94a3b8", fontSize: "7.5pt" }}>
                  توقيع المريض / الولي الرقمي
                </span>
              )}
            </div>
            <div style={{ fontSize: "7.5pt", color: "#64748b" }}>
              التاريخ: {friendlyDateLong(dateStr)}
            </div>
          </div>

          {/* شاهد الجلسة / التمريض المعاون */}
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: "8.5pt", fontWeight: 800, color: "#0f172a", marginBottom: "1mm" }}>
              الشاهد / التمريض المعاون
            </div>
            <div style={{ fontSize: "8pt", color: "#334155" }}>
              الاسم: .......................................
            </div>
            <div style={{ height: "18mm", borderBottom: "1px dotted #94a3b8", margin: "1.5mm auto 0", width: "85%" }} />
            <div style={{ fontSize: "7.5pt", color: "#64748b", marginTop: "1.5mm" }}>
              التوقيع
            </div>
          </div>

          {/* الطبيب المعالج وختم المركز */}
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: "8.5pt", fontWeight: 800, color: "#0f172a", marginBottom: "1mm" }}>
              الطبيب المعالج · Attending Doctor
            </div>
            <div style={{ fontSize: "8pt", color: "#334155" }}>
              الاسم: <strong>د. {doctorName}</strong>
            </div>
            <div style={{ height: "18mm", borderBottom: "1px dotted #94a3b8", margin: "1.5mm 0" }} />
            <div style={{ fontSize: "7.5pt", color: "#64748b" }}>
              التوقيع والختم المهني
            </div>
          </div>
        </div>

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
