import { notFound } from "next/navigation";
import { CLINIC_TIME_ZONE, getOrthoCase, getPatient, getSettingsSafe, listPatientDocuments } from "@/lib/db";
import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { PrintButton } from "@/components/PrintButton";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { clinicDateString } from "@/lib/schedule";
import {
  PHOTO_STAGE_LABEL, PHOTO_VIEW_PRINT_LABEL, isPhotoStage, photoPrintLayout, photoStageRequirements,
  type PhotoStage,
} from "@/lib/ortho-photos";
import { buildCaptureSheet, type SheetCell } from "@/lib/ortho-photo-completeness";

export const dynamic = "force-dynamic";

/**
 * OP-3 — ورقة صور مجموعة تصوير واحدة (مرحلة + تاريخ + جلسة).
 * العقد: docs/review/ortho-wire-timeline-photo-records-contract-20261118.md (v2.1).
 *
 * - الترويسة من مفاتيح هوية المركز في الإعدادات، والترتيب من `ortho.photo_print_layout`.
 * - الصور تُعرض كما رُفعت من المسار المحمي `/api/documents/{id}`: لا قص ولا تدوير ولا قلب.
 * - المنظر المطلوب الناقص إطار فارغ «غير مصوّرة»؛ لا تُخلط صور تواريخ أو جلسات أخرى.
 * - الصلاحية: الجلسة، ثم الوصول إلى المريض (وإلا «غير موجود» دون كشف)، ثم صلاحية الصور.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[1-9]\d{0,9}$/;

const PAGE_STYLES = `
  @media print { @page { size: A4; } }
  .photo-sheet-grid { display: grid; gap: 3mm; margin-top: 3mm; }
  .photo-frame { border: 0.3mm solid #cbd5e1; border-radius: 1.5mm; padding: 1.5mm; display: flex; flex-direction: column; break-inside: avoid; }
  .photo-frame .photo-box { height: 46mm; display: flex; align-items: center; justify-content: center; background: #f8fafc; }
  .photo-frame img { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; }
  .photo-frame .photo-label { margin-top: 1mm; font-size: 8pt; font-weight: 700; color: #0f172a; text-align: center; }
  .photo-frame.missing .photo-box { border: 0.3mm dashed #94a3b8; color: #64748b; font-size: 9pt; }
  @media screen and (max-width: 600px) {
    .ortho-photo-sheet { width: 100% !important; min-height: 0 !important; padding: 6mm 4mm !important; box-sizing: border-box; }
    .photo-sheet-grid { grid-template-columns: 1fr 1fr !important; }
  }
`;

type SearchValue = string | string[] | undefined;

function Message({ text }: { text: string }) {
  return (
    <div className="sheet sheet-a4 ortho-photo-sheet" style={{ padding: "10mm 12mm" }}>
      <p role="alert" style={{ border: "1.5px solid #b91c1c", borderRadius: "2mm", padding: "4mm", color: "#7f1d1d", backgroundColor: "#fef2f2", fontWeight: 700 }}>
        {text}
      </p>
    </div>
  );
}

function Frame({ cell }: { cell: SheetCell }) {
  const label = PHOTO_VIEW_PRINT_LABEL[cell.view];
  return (
    <figure className={`photo-frame${cell.photo ? "" : " missing"}`} style={{ margin: 0 }} data-view={cell.view}>
      <div className="photo-box">
        {cell.photo
          ? <img className="print-watermark-protected" src={`/api/documents/${cell.photo.id}`} alt={label} style={{ objectFit: "contain" }} />
          : <span>غير مصوّرة</span>}
      </div>
      <figcaption className="photo-label">
        {label}{cell.extraCount > 0 ? ` (+${cell.extraCount} صورة أخرى من هذا المنظر)` : ""}
      </figcaption>
    </figure>
  );
}

export default async function OrthoPhotoSheetPage({ params, searchParams }: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<Record<string, SearchValue>>;
}) {
  const session = await requireSession();
  if (!session) return <Message text="انتهت الجلسة. سجّل الدخول من جديد." />;

  const { caseId: rawCaseId } = await params;
  if (!ID.test(rawCaseId)) notFound();
  const caseId = Number(rawCaseId);

  const orthoCase = await getOrthoCase(caseId, clinicDateString(new Date(), CLINIC_TIME_ZONE)).catch(() => null);
  if (!orthoCase) notFound();
  const patientId = orthoCase.patientId;
  // حرس الباب: الصفحة تتحقق بنفسها من الوصول إلى المريض، وغير المسموح كغير الموجود.
  if (!(await canAccessPatient(session, patientId).catch(() => false))) notFound();

  const query = await searchParams;
  const stage = query.stage, date = query.date, adjustment = query.adjustment;
  const valid = typeof stage === "string" && isPhotoStage(stage)
    && typeof date === "string" && DATE.test(date)
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
    && typeof adjustment === "string" && (adjustment === "none" || ID.test(adjustment));
  if (!valid) return <Message text="رابط مجموعة التصوير غير صالح." />;

  // الصلاحية نفسها التي تفتح بها الصور (`/api/documents/[id]`).
  if (!(await canAccessPatient(session, patientId, "canViewXrays").catch(() => false))) {
    return <Message text="لا صلاحية لعرض صور المريض." />;
  }

  const [patient, settings, documents] = await Promise.all([
    getPatient(patientId), getSettingsSafe(), listPatientDocuments(patientId),
  ]);
  if (!patient) notFound();

  const sheet = buildCaptureSheet({
    documents: documents.map(doc => ({
      id: doc.id, patientId: doc.patientId, orthoCaseId: doc.orthoCaseId ?? null, adjustmentId: doc.adjustmentId ?? null,
      isImage: doc.isImage, removedAt: doc.removedAt ?? null, photoStage: doc.photoStage ?? null,
      photoView: doc.photoView ?? null, takenOn: doc.takenOn ?? null,
    })),
    patientId, caseId, stage: stage as PhotoStage, takenOn: date as string,
    adjustmentId: adjustment === "none" ? null : Number(adjustment),
    requirements: photoStageRequirements(settings["ortho.photo_stage_requirements"]),
    layout: photoPrintLayout(settings["ortho.photo_print_layout"]),
  });

  return (
    <>
      <style>{PAGE_STYLES}</style>
      <PrintButton />
      <div className="sheet sheet-a4 ortho-photo-sheet" style={{ padding: "10mm 12mm", fontSize: "9pt" }}>
        <PrintHeader settings={settings} title={`${PHOTO_STAGE_LABEL[stage as PhotoStage]} — صور التقويم`} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2mm 8mm", margin: "3mm 0" }}>
          <div><span style={{ color: "#64748b" }}>اسم المريض: </span><strong>{patient.fullName}</strong></div>
          <div><span style={{ color: "#64748b" }}>رقم الملف: </span><bdi dir="ltr">{patient.patientNumber}</bdi></div>
          <div><span style={{ color: "#64748b" }}>الحالة: </span><bdi dir="ltr">#{caseId}</bdi></div>
          <div><span style={{ color: "#64748b" }}>تاريخ الالتقاط: </span><bdi dir="ltr">{date}</bdi></div>
          {adjustment === "none" ? <div style={{ color: "#64748b" }}>صور غير مرتبطة بجلسة</div> : null}
        </div>
        {sheet.status === "empty" ? (
          <p role="status" style={{ marginTop: "6mm", color: "#334155" }}>لا توجد صور في مجموعة التصوير هذه.</p>
        ) : (
          <>
            {sheet.rows.map((row, index) => (
              <div key={index} className="photo-sheet-grid" style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}>
                {row.map(cell => <Frame key={cell.view} cell={cell} />)}
              </div>
            ))}
            {sheet.otherViews.length > 0 ? (
              <>
                <p style={{ marginTop: "3mm", fontWeight: 700 }}>مناظر أخرى مصوّرة</p>
                <div className="photo-sheet-grid" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
                  {sheet.otherViews.map(cell => <Frame key={cell.view} cell={cell} />)}
                </div>
              </>
            ) : null}
            {sheet.missingRequired.length > 0 ? (
              <p style={{ marginTop: "3mm", color: "#92400e" }}>
                ناقص من المناظر المطلوبة لهذه المرحلة: {sheet.missingRequired.map(view => PHOTO_VIEW_PRINT_LABEL[view]).join("، ")}
              </p>
            ) : null}
            <p style={{ marginTop: "2mm", fontSize: "7.5pt", color: "#64748b" }}>
              الصور كما رُفعت دون تعديل. الجانب يُذكر بجانب المريض.
            </p>
          </>
        )}
        <PrintFooter settings={settings} />
      </div>
    </>
  );
}
