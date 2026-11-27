import { NextResponse } from "next/server";
import {
  DocumentAssociationError, getPool, getSettings, listPatientDocuments, recordAudit, recordDocument,
  validateDocumentAssociations,
} from "@/lib/db";
import { putFile, storageStatus } from "@/lib/files";
import { imageSize } from "@/lib/imageSize";
import { isAdmin } from "@/lib/roles";
import { DEFAULT_MAX_BYTES, isDocumentKind, validateUpload } from "@/lib/storage";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { evaluateOrthoPermission, NO_STORE_HEADERS, orthoForbiddenResponse } from "@/lib/ortho-privacy-server";
import { bodyErrorResponse, readBoundedFormData } from "@/lib/http-body";
import { UPLOAD_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { contentMatchesMimeType, SIGNATURE_MISMATCH_MESSAGE } from "@/lib/magic-bytes";
import { CONSENT_RECORD_NOTE_LIMIT, DOCUMENT_NOTE_LIMIT, parseStoredConsent } from "@/lib/consent-record";

const CONSENT_NOTE_INVALID_MESSAGE = "بيانات الإقرار ناقصة أو أطول من الحد المسموح، فلم يُحفظ شيء. أعد فتح نموذج الإقرار وحاول مجددًا.";

export const dynamic = "force-dynamic";

/**
 * أشعة المريض ومستنداته.
 *
 * الملفّ يُكتب على القرص **قبل** أن يُسجَّل وصفه: ملفٌّ بلا صفٍّ في القاعدة نفايةٌ
 * صامتة تُنظَّف لاحقًا، وصفٌّ بلا ملفّ سجلٌّ يَعِد بأشعةٍ لا توجد — والثاني أسوأ،
 * لأن الطبيب يبني عليه.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const patientIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });

  /* صلاحيات الوكيل المساعد + عزل V2: الطبيب بلا صلاحية الأشعة ممنوع، ومن يملكها
     لا يرى إلا أشعة مرضاه — الفحص في الخادم لا في الشاشة. */
  if (!(await canAccessPatient(session, patientId, "canViewXrays"))) {
    return NextResponse.json({ message: "غير مصرّح لك بالوصول إلى مستندات هذا المريض." }, { status: 403, headers: NO_STORE_HEADERS });
  }

  try {
    const storage = await storageStatus();
    const allDocs = await listPatientDocuments(patientId, isAdmin(session.role));
    const orthoPhotoGate = await evaluateOrthoPermission(
      session,
      { permission: "photos.view", field: "previousPhotos" },
      { patientId },
    );
    const documents = orthoPhotoGate.allowed
      ? allDocs
      : allDocs.filter((doc) => doc.orthoCaseId == null && doc.adjustmentId == null && doc.photoStage == null);
    return NextResponse.json(
      {
        documents,
        // الشاشة تحتاج أن تعرف قبل أن يختار المستخدم ملفًّا — لا بعد أن يرفعه فيفشل.
        storageReady: storage.ready,
        storageMessage: storage.ready ? null : storage.message,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المستندات." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });

  /* صلاحيات الوكيل المساعد + عزل V2 + صلاحيات الإدخال الأعمى لوحدة التقويم:
     يمكن للمالك منح المساعد صلاحية التقاط/رفع صور الشدّة لمرضى اليوم دون السماح له برؤية الصور السابقة. */
  const canLegacyUpload = await canAccessPatient(session, patientId, "canUploadXrays");
  const canBasePatient = canLegacyUpload ? true : await canAccessPatient(session, patientId);
  const blindOrthoUploadGate = !canLegacyUpload && canBasePatient
    ? await evaluateOrthoPermission(
        session,
        { anyOfPermissions: ["photos.capture", "photos.upload"] },
        { patientId },
      )
    : null;
  if (!canLegacyUpload && !blindOrthoUploadGate?.allowed) {
    return NextResponse.json({ message: "غير مصرّح لك بالوصول إلى مستندات هذا المريض." }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const storage = await storageStatus();
  if (!storage.ready) {
    // ٥٠٣ لا ٥٠٠: العطل في التهيئة لا في الطلب، والرسالة تقول ما يُضبط.
    return NextResponse.json({ message: storage.message }, { status: 503 });
  }

  let form: FormData;
  try {
    /* (P2/S8) multipart محدود القراءة: بلا حد، جسم غير معلن الحجم يستهلك
       الذاكرة قبل أن يصل الملف إلى أي فحص. */
    form = await readBoundedFormData(request, UPLOAD_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ message: "اختر ملفًّا." }, { status: 400 });
  }

  const settings = await getSettings();
  const configured = Number(settings["documents.max_megabytes"]);
  const maxBytes = Number.isFinite(configured) && configured > 0
    ? Math.round(configured * 1024 * 1024) : DEFAULT_MAX_BYTES;

  const check = validateUpload({ mimeType: file.type, sizeBytes: file.size, maxBytes });
  if (!check.ok) return NextResponse.json({ message: check.message }, { status: 400 });

  const rawKind = form.get("kind");
  const kind = isDocumentKind(rawKind) ? rawKind : "other";
  const rawTitle = typeof form.get("title") === "string" ? String(form.get("title")).trim() : "";
  const title = (rawTitle || file.name || "مستند").slice(0, 120);
  const rawNote = typeof form.get("note") === "string" ? String(form.get("note")).trim() : "";
  const rawTaken = typeof form.get("takenOn") === "string" ? String(form.get("takenOn")) : "";
  /* (Codex P1 on #291) A signed consent's structured note (JSON from the consent form) is its record: the reprint reads it
     strictly (`parseStoredConsent`). It is kept whole up to a bound, never cut at 300 characters into invalid JSON, and a
     structured record the reprint could not read is refused before anything is written. A free-text note (a scanned paper
     consent from the generic upload) and every other document keep their 300-character note unchanged. */
  const consentRecord = kind === "consent" && rawNote.startsWith("{");
  if (consentRecord && (rawNote.length > CONSENT_RECORD_NOTE_LIMIT || parseStoredConsent(rawNote) === null)) {
    return NextResponse.json({ message: CONSENT_NOTE_INVALID_MESSAGE }, { status: 400 });
  }
  const note = !rawNote ? null : consentRecord ? rawNote : rawNote.slice(0, DOCUMENT_NOTE_LIMIT);
  const takenOn = DATE_PATTERN.test(rawTaken) ? rawTaken : null;
  // ربط صور التقويم: الحالة والشدّة التي صُوّرت فيها ودورُها ووجهُها — وألبوم
  // الجلسة يُبنى من هذا الربط، فالصورة التي بلا ربطٍ تضيع في الشبكة كلها.
  // Empty optional fields remain absent; malformed explicit references fail closed.
  const optionalId = (value: FormDataEntryValue | null): number | null | undefined => {
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= 2147483647 ? parsed : undefined;
  };
  const visitId = optionalId(form.get("visitId"));
  const orthoCaseId = optionalId(form.get("orthoCaseId"));
  const adjustmentId = optionalId(form.get("adjustmentId"));
  if (visitId === undefined || orthoCaseId === undefined || adjustmentId === undefined) {
    return NextResponse.json({ message: new DocumentAssociationError().message }, { status: 400 });
  }
  const rawStage = form.get("photoStage");
  const photoStage = typeof rawStage === "string"
    && ["initial", "progress", "debond", "retention"].includes(rawStage) ? rawStage : null;
  const rawView = form.get("photoView");
  const photoView = typeof rawView === "string" && /^[a-z_]{3,30}$/.test(rawView)
    ? rawView.slice(0, 30) : null;

  const isOrthoUpload = Boolean(orthoCaseId != null || adjustmentId != null || photoStage != null);
  if (blindOrthoUploadGate && !isOrthoUpload) {
    return orthoForbiddenResponse("صلاحية الإدخال الممنوحة مقتصرة على صور وحدة التقويم فقط.");
  }
  let orthoUploadAccess = blindOrthoUploadGate?.access ?? null;
  if (isOrthoUpload) {
    const orthoGate = await evaluateOrthoPermission(
      session,
      { anyOfPermissions: ["photos.capture", "photos.upload"] },
      { patientId, orthoCaseId },
    );
    if (!orthoGate.allowed && (orthoGate.subject !== null || !canLegacyUpload)) {
      return orthoForbiddenResponse("غير مصرّح لك بالتقاط أو رفع صور وحدة التقويم لهذه الحالة.");
    }
    if (orthoGate.access) orthoUploadAccess = orthoGate.access;
  }

  try {
    await validateDocumentAssociations({ patientId, visitId, orthoCaseId, adjustmentId });
    const bytes = Buffer.from(await file.arrayBuffer());
    /* (P2/S9) بصمة المحتوى الفعلية (magic bytes): المُمَوّه يكتبه العميل —
       البايتات لا تكذب. ملف يقول image/png ومحتواه تنفيذي/نص ⇒ رفض قبل
       أي كتابة على القرص، والتخزين يبقى content-addressed كما هو. */
    if (!contentMatchesMimeType(bytes, file.type)) {
      await recordAudit({
        action: "document.upload.rejected_signature",
        entity: "patient_documents",
        entityId: String(patientId),
        details: { declared_mime: file.type, size: bytes.length },
        actor: session.username,
        actorRole: session.role,
      });
      return NextResponse.json({ message: SIGNATURE_MISMATCH_MESSAGE }, { status: 400 });
    }
    /* أبعاد الصورة من ترويسة الملف (من مستودع الوكيل الآخر) — بلا مكتبة:
       التراكب والمقارنة يرسمان فوق الشععة فيحتاجان مقاسها، و`null` ليست عطلًا
       فالمستندُ PDF لا أبعاد صورة له. */
    const dimensions = imageSize(bytes);
    const stored = await putFile(bytes, check.extension);

    // منع تكرار صور الشدّة عند إعادة المحاولة بعد انقطاع الإنترنت (Idempotent Session Photo Upload):
    // إذا وُجد مستند نشط لنفس المريض والشدّة بنفس البصمة sha256 ونفس الوجه المصوَّر، يُعاد الموجود بلا تكرار.
    if (adjustmentId != null && photoView != null && typeof getPool === "function") {
      try {
        const dup = await getPool().query<{
          id: number; title: string; photo_stage: string | null; photo_view: string | null;
          ortho_case_id: number | null; adjustment_id: number | null; note: string | null;
          taken_on: string | null; uploaded_by: string; uploaded_at: string; mime_type: string;
          size_bytes: number; kind: string; patient_id: number;
        }>(
          `SELECT id, patient_id, kind, title, mime_type, size_bytes, note, taken_on::text AS taken_on,
                  uploaded_by, uploaded_at::text AS uploaded_at, ortho_case_id, adjustment_id, photo_stage, photo_view
             FROM patient_documents
            WHERE patient_id = $1
              AND adjustment_id = $2
              AND sha256 = $3
              AND photo_view = $4
              AND removed_at IS NULL
            ORDER BY id ASC
            LIMIT 1`,
          [patientId, adjustmentId, stored.sha256, photoView],
        );
        if (dup.rows[0]) {
          const existing = dup.rows[0];
          const blind = Boolean(isOrthoUpload && orthoUploadAccess && !orthoUploadAccess.permissions["photos.view"]);
          return NextResponse.json(
            blind
              ? {
                  id: existing.id,
                  title: existing.title,
                  photoStage: existing.photo_stage,
                  photoView: existing.photo_view,
                  orthoCaseId: existing.ortho_case_id,
                  adjustmentId: existing.adjustment_id,
                  blindReceipt: true,
                  existing: true,
                }
              : {
                  id: existing.id,
                  patientId: existing.patient_id,
                  kind: existing.kind,
                  title: existing.title,
                  mimeType: existing.mime_type,
                  sizeBytes: Number(existing.size_bytes),
                  note: existing.note,
                  takenOn: existing.taken_on,
                  uploadedBy: existing.uploaded_by,
                  uploadedAt: existing.uploaded_at,
                  orthoCaseId: existing.ortho_case_id,
                  adjustmentId: existing.adjustment_id,
                  photoStage: existing.photo_stage,
                  photoView: existing.photo_view,
                  existing: true,
                },
            { status: 200, headers: NO_STORE_HEADERS },
          );
        }
      } catch {
        // Fallback to standard insert if mock pool doesn't support this query shape.
      }
    }

    const document = await recordDocument({
      patientId, visitId, kind, title,
      mimeType: file.type,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.key,
      note,
      takenOn,
      uploadedBy: session.username,
      orthoCaseId,
      adjustmentId,
      photoStage,
      photoView,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    });
    void recordAudit({
      action: "document.upload",
      entity: "patient_documents",
      entityId: document.id,
      entityLabel: title,
      details: { المريض: patientId, النوع: kind, الحجم: document.sizeBytes },
      actor: session.username,
      actorRole: session.role,
    });
    if (isOrthoUpload && orthoUploadAccess && !orthoUploadAccess.permissions["photos.view"]) {
      return NextResponse.json(
        {
          id: document.id,
          title: document.title,
          photoStage: document.photoStage,
          photoView: document.photoView,
          orthoCaseId: document.orthoCaseId,
          adjustmentId: document.adjustmentId,
          blindReceipt: true,
        },
        { status: 201, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(document, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof DocumentAssociationError) {
      return NextResponse.json({ message: error.message }, { status: 400 });
    }
    return NextResponse.json({ message: "تعذّر حفظ الملف. أعد المحاولة." }, { status: 500 });
  }
}
