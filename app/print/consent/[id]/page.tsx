import { notFound } from "next/navigation";
import { getPatient, getSettingsSafe, getDocumentForDownload } from "@/lib/db";
import { ageFromBirthYear, ageText, GENDER_LABEL } from "@/lib/patient";
import { friendlyDateLong } from "@/lib/reminders";
import { PrintHeader, PrintFooter } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { CONSENT_ACKNOWLEDGEMENT, isConsentDate, parseStoredConsentDocumentMetadata, type ConsentDocumentMetadata } from "@/lib/consent-document";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { getConsentTemplate } from "@/lib/consent-templates";

export const dynamic = "force-dynamic";

interface ConsentSearchParams {
  [key: string]: string | string[] | undefined;
}

const queryText = (value: string | string[] | undefined, maximum = 200) =>
  typeof value === "string" && value.length <= maximum ? value.trim() : "";

// The same native table-header pagination pattern used by the patient dossier.
// Headers reserve page space; no fixed overlay can cover a saved clinical clause.
const CONSENT_PRINT_STYLES = `
  .consent-pagination { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .consent-pagination > thead { display: none; }
  .consent-pagination > thead > tr > td,
  .consent-pagination > tbody > tr > td { padding: 0; border: 0; vertical-align: top; }
  .consent-sheet { overflow-wrap: anywhere; }
  @media print {
    @page consent {
      size: A4;
      margin: 8mm 8mm 14mm;
      @bottom-center {
        content: counter(page) " / " counter(pages);
        direction: ltr;
        font: 8pt Arial, sans-serif;
        color: #475569;
      }
    }
    .consent-sheet { page: consent; padding: 0 !important; }
    .consent-pagination > thead { display: table-header-group; }
    .consent-pagination > tbody > tr { break-inside: auto; page-break-inside: auto; }
    .consent-repeating-context {
      display: grid; grid-template-columns: minmax(0, 1fr) auto;
      gap: 1mm 4mm; padding-bottom: 2mm; margin-bottom: 3mm;
      border-bottom: 1px solid #94a3b8; font-size: 8pt; line-height: 1.4;
    }
    .consent-repeating-context .consent-procedure { grid-column: 1 / -1; }
    .consent-repeating-context .consent-record { white-space: nowrap; }
    .consent-signatures { break-inside: avoid; page-break-inside: avoid; }
    .consent-clause { orphans: 3; widows: 3; }
  }
`;

/**
 * وثيقة الإقرار والموافقة الطبية المستنيرة الرسمية — مقاس A4.
 *
 * النسخة الموقّعة تعرض النص المحفوظ فقط. المستند القديم أو غير المكتمل لا
 * يتحول إلى إقرار جديد، والمعاينة بلا مستند مسودة غير موقّعة.
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
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(patientId) || patientId > 2147483647) notFound();

  const sParams = await searchParams;
  const savedRequested = sParams.docId !== undefined;
  // A saved consent has exactly the document-read authority of its original file.
  if (!(await canAccessPatient(session, patientId, savedRequested ? "canViewXrays" : undefined).catch(() => false))) notFound();
  const [patient, settings] = await Promise.all([getPatient(patientId), getSettingsSafe()]);
  if (!patient) notFound();

  let saved: ConsentDocumentMetadata | null = null;
  let signatureDocId: number | null = null;
  if (savedRequested) {
    const rawDocId = sParams.docId;
    if (typeof rawDocId !== "string" || !/^[1-9]\d*$/.test(rawDocId)) notFound();
    const docId = Number(rawDocId);
    if (!Number.isSafeInteger(docId) || docId > 2147483647) notFound();
    const result = await getDocumentForDownload(docId).catch(() => null);
    const document = result?.document;
    if (!document || document.id !== docId || document.patientId !== patientId
      || document.kind !== "consent" || document.removedAt !== null) notFound();
    const parsed = parseStoredConsentDocumentMetadata(document.note, document);
    if (!parsed.ok || document.mimeType !== "image/png") {
      // Never replay a bare signature onto a guessed or current template. The
      // original remains accessible without rewriting or "repairing" history.
      return <>
        <PrintButton />
        <div className="sheet sheet-a4" dir="rtl" style={{ padding: "12mm" }}>
          <PrintHeader settings={settings} title="سجل إقرار غير قابل للتحقق" compact />
          <div role="alert" style={{ marginTop: "8mm", border: "2px solid #b45309", padding: "5mm", color: "#92400e" }}>
            <h2>بيانات الإقرار غير مكتملة أو غير قابلة للتحقق</h2>
            <p>المستند #{document.id} لا يتضمن نسخة محفوظة مكتملة من النص الذي عُرض عند التوقيع. لا يمكن نسب التوقيع إلى نموذج علاجي محدد أو إعادة إنشاء إقرار موقّع منه.</p>
            <p>يشمل ذلك المستندات الممسوحة ضوئياً والإقرارات القديمة. راجع المستند الأصلي كما حُفظ.</p>
            <a href={`/api/documents/${document.id}`} target="_blank" rel="noopener noreferrer">عرض المستند الأصلي</a>
          </div>
          <PrintFooter settings={settings} />
        </div>
      </>;
    }
    saved = parsed.metadata;
    signatureDocId = document.id;
  }

  // Query values can configure only an unsigned draft. A requested saved record
  // must never fall through into this branch, even when its lookup/metadata fails.
  const templateId = saved?.templateId || queryText(sParams.templateId, 80) || "surgical_extraction";
  const previewTemplate = saved ? null : getConsentTemplate(templateId);
  if (!saved && !previewTemplate) notFound();
  const template = saved?.content ?? previewTemplate;
  if (!template) notFound();
  const signatoryName = saved?.signatoryName ?? (queryText(sParams.signatoryName) || patient.fullName);
  const signatoryRelation = saved?.signatoryRelation ?? (sParams.signatoryRelation === "guardian" ? "guardian" : "self");
  const guardianRelation = saved?.guardianRelation ?? (saved ? "" : queryText(sParams.guardianRelation, 120));
  // An uploader/current viewer is not necessarily the treating doctor.
  const doctorName = saved ? "" : queryText(sParams.doctorName);
  const dateStr = saved?.takenOn ?? (isConsentDate(sParams.date) ? sParams.date : clinicDateString(new Date(), CLINIC_ZONE_FALLBACK));

  const age = ageFromBirthYear(patient.birthYear, dateStr);

  return (
    <>
      <PrintButton />
      <style>{CONSENT_PRINT_STYLES}</style>
      <div className="sheet sheet-a4 consent-sheet" dir="rtl" style={{ padding: "10mm 12mm", fontSize: "9pt", lineHeight: "1.45" }}>
        <table className="consent-pagination">
          <thead><tr><td>
            <div className="consent-repeating-context">
              <strong>المريض: {saved?.patientName ?? patient.fullName}</strong>
              <strong className="consent-record">معرّف المريض الداخلي: #{patientId}{signatureDocId ? ` · مستند #${signatureDocId}` : " · مسودة غير موقّعة"}</strong>
              <span className="consent-procedure">الإجراء: {template.procedureName} · <bdi dir="ltr">{templateId}</bdi></span>
              <span>تاريخ الإقرار: <bdi dir="ltr">{dateStr}</bdi></span>
            </div>
          </td></tr></thead>
          <tbody><tr><td>
        <PrintHeader
          settings={settings}
          title="إقرار موافقة مستنيرة على إجراء علاجي أو جراحي سني"
          compact
        />

        <p style={{ margin: "3mm 0", padding: "2mm", background: saved ? "#f0fdf4" : "#fffbeb", fontWeight: 700 }}>
          {saved ? `نسخة من نص الإقرار المحفوظ · مستند #${signatureDocId}` : "مسودة غير موقّعة — للمراجعة فقط، لا تثبت موافقة أو توقيعاً"}
        </p>
        {saved && <p>اسم المريض عند عرض الإقرار: <strong>{saved.patientName}</strong></p>}
        {saved && <p style={{ fontSize: "8pt" }}>بيانات الملف الحالية أدناه للتعريف بالمريض؛ نص الإقرار وبيانات الموقّع والتاريخ من المستند المحفوظ.</p>}
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
        {!saved && patient.medicalAlert && (
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
              كود الإقرار: {templateId}
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
              <li key={index} className="consent-clause" style={{ paddingRight: "1mm" }}>
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
              <li key={index} className="consent-clause" style={{ paddingRight: "1mm" }}>
                {risk}
              </li>
            ))}
          </ul>
        </div>

        {/* Preview-only instructions were not shown in the signing modal. */}
        {previewTemplate && <div style={{ marginTop: "3mm" }}>
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
            {previewTemplate.postOpInstructions.map((care, index) => (
              <li key={index} style={{ paddingRight: "1mm" }}>
                {care}
              </li>
            ))}
          </ul>
        </div>}

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
          {saved?.content.acknowledgement ?? CONSENT_ACKNOWLEDGEMENT}
        </div>

        {/* منطقة التواقيع والاعتماد */}
        <div
          className="consent-signatures"
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
              الاسم: <strong>{doctorName ? `د. ${doctorName}` : "......................................."}</strong>
            </div>
            <div style={{ height: "18mm", borderBottom: "1px dotted #94a3b8", margin: "1.5mm 0" }} />
            <div style={{ fontSize: "7.5pt", color: "#64748b" }}>
              التوقيع والختم المهني
            </div>
          </div>
        </div>

        <PrintFooter settings={settings} />
          </td></tr></tbody>
        </table>
      </div>
    </>
  );
}
