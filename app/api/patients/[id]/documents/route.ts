import { NextResponse } from "next/server";
import {
  getSettings, listPatientDocuments, recordAudit, recordDocument,
} from "@/lib/db";
import { putFile, storageStatus } from "@/lib/files";
import { isAdmin } from "@/lib/roles";
import { DEFAULT_MAX_BYTES, isDocumentKind, validateUpload } from "@/lib/storage";
import { requireSession } from "@/lib/session";

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

  try {
    const storage = await storageStatus();
    return NextResponse.json({
      documents: await listPatientDocuments(patientId, isAdmin(session.role)),
      // الشاشة تحتاج أن تعرف قبل أن يختار المستخدم ملفًّا — لا بعد أن يرفعه فيفشل.
      storageReady: storage.ready,
      storageMessage: storage.ready ? null : storage.message,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المستندات." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });

  const storage = await storageStatus();
  if (!storage.ready) {
    // ٥٠٣ لا ٥٠٠: العطل في التهيئة لا في الطلب، والرسالة تقول ما يُضبط.
    return NextResponse.json({ message: storage.message }, { status: 503 });
  }

  let form: FormData;
  try { form = await request.formData(); } catch {
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
  const rawVisit = Number(form.get("visitId"));
  const visitId = Number.isInteger(rawVisit) && rawVisit > 0 ? rawVisit : null;
  const rawTaken = typeof form.get("takenOn") === "string" ? String(form.get("takenOn")) : "";
  const takenOn = DATE_PATTERN.test(rawTaken) ? rawTaken : null;

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const stored = await putFile(bytes, check.extension);
    const document = await recordDocument({
      patientId, visitId, kind, title,
      mimeType: file.type,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.key,
      note: rawNote ? rawNote.slice(0, 300) : null,
      takenOn,
      uploadedBy: session.username,
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
    return NextResponse.json(document, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الملف. أعد المحاولة." }, { status: 500 });
  }
}
