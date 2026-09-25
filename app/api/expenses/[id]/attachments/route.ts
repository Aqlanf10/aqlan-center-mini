import { NextResponse } from "next/server";
import { getExpense, getSettings, listExpenseAttachments, recordAudit, recordExpenseAttachment } from "@/lib/db";
import { putFile, storageStatus } from "@/lib/files";
import { canHandleMoney } from "@/lib/roles";
import { DEFAULT_MAX_BYTES, validateUpload } from "@/lib/storage";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readBoundedFormData } from "@/lib/http-body";
import { UPLOAD_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { contentMatchesMimeType, SIGNATURE_MISMATCH_MESSAGE } from "@/lib/magic-bytes";

export const dynamic = "force-dynamic";

/**
 * (P3-6) مرفقات سند الصرف — صورة الإيصال أو فاتورة المورّد.
 *
 * المال للإدارة والاستقبال وحدهما، فالمرفق كذلك. والملفّ يمرّ من الفحوص نفسها التي
 * تمرّ منها الأشعة: نوعٌ مسموح وحجمٌ من الإعدادات وبصمة محتوى تطابق النوع المعلن.
 * والسجل append-only: المرفق شاهدٌ لا يُبدَّل.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });

const expenseIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) return forbidden();
  const expenseId = await expenseIdFrom(context);
  if (!expenseId) return NextResponse.json({ message: "رقم السند غير صالح." }, { status: 400 });
  try {
    return NextResponse.json({ attachments: await listExpenseAttachments(expenseId) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المرفقات." }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) return forbidden();
  const expenseId = await expenseIdFrom(context);
  if (!expenseId) return NextResponse.json({ message: "رقم السند غير صالح." }, { status: 400 });

  const expense = await getExpense(expenseId).catch(() => null);
  if (!expense) return NextResponse.json({ message: "سند الصرف غير موجود." }, { status: 404 });

  const storage = await storageStatus();
  if (!storage.ready) return NextResponse.json({ message: storage.message }, { status: 503 });

  let form: FormData;
  try {
    form = await readBoundedFormData(request, UPLOAD_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ message: "اختر ملفًّا." }, { status: 400 });

  const settings = await getSettings();
  const configured = Number(settings["documents.max_megabytes"]);
  const maxBytes = Number.isFinite(configured) && configured > 0
    ? Math.round(configured * 1024 * 1024) : DEFAULT_MAX_BYTES;
  const check = validateUpload({ mimeType: file.type, sizeBytes: file.size, maxBytes });
  if (!check.ok) return NextResponse.json({ message: check.message }, { status: 400 });

  const rawTitle = typeof form.get("title") === "string" ? String(form.get("title")).trim() : "";
  const title = (rawTitle || file.name || "إيصال").slice(0, 120);

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!contentMatchesMimeType(bytes, file.type)) {
      return NextResponse.json({ message: SIGNATURE_MISMATCH_MESSAGE }, { status: 400 });
    }
    const stored = await putFile(bytes, check.extension);
    const attachment = await recordExpenseAttachment({
      expenseId, title, mimeType: file.type, sizeBytes: stored.sizeBytes,
      sha256: stored.sha256, storageKey: stored.key, uploadedBy: session.username,
    });
    if (!attachment) return NextResponse.json({ message: "سند الصرف غير موجود." }, { status: 404 });
    /* يُنتظر قبل الرد: سطر التدقيق جزءٌ من الفعل لا ذيلٌ بعده — من رأى «تم»
       ثم فتح السجل يجده (وكان يسبقه أحيانًا تحت الحِمل). وrecordAudit يبتلع أخطاءه. */
    await recordAudit({
      action: "expense.attachment", entity: "expense", entityId: expenseId,
      entityLabel: expense.voucherNumber,
      details: { السند: expense.voucherNumber, الملف: title, الحجم: attachment.sizeBytes },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(attachment, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الملف. أعد المحاولة." }, { status: 500 });
  }
}
