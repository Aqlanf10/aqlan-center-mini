import { NextResponse } from "next/server";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { canonicalDocumentFailure, commandCanonicalDocumentHide, readCanonicalDocumentFile } from "@/lib/canonical-documents";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getDocumentForDownload, recordAudit, removeDocument } from "@/lib/db";
import { readFileByKey } from "@/lib/files";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * تنزيل مستند — بجلسةٍ لا برابطٍ عام.
 *
 * أشعةُ المريض بياناتٌ طبية. ولو خرجت من رابطٍ ثابتٍ مفتوح لصارت مقروءةً لكل من
 * وصل إليه: أُرسل في محادثة، أو بقي في سجل متصفّح، أو فُهرس. فيمرّ كل تنزيل من
 * هنا: جلسةٌ صالحة أولًا، ثم يُقرأ الملف من القرص بمفتاحٍ لا يخرج إلى المتصفّح
 * أصلًا — المتصفّح يعرف رقم المستند فقط.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  /* M2 slice 75: clinical.xrays.view inside the patient scope; the file read only after admission. */
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const { document, bytes } = await readCanonicalDocumentFile(selected.handle, (await context.params).id);
      const download = new URL(request.url).searchParams.get("download") === "1";
      return new NextResponse(new Uint8Array(bytes), { headers: {
        "Content-Type": document.mimeType, "Content-Length": String(bytes.length),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(document.title)}`,
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      } });
    } catch (error) { return canonicalDocumentFailure(error, "تعذّر فتح المستند."); }
  }
  const session = await requireSession();
  if (!session) return denied();
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم المستند غير صالح." }, { status: 400 });

  try {
    const found = await getDocumentForDownload(id);
    if (!found) return NextResponse.json({ message: "المستند غير موجود." }, { status: 404 });
    if (!(await canAccessPatient(session, found.document.patientId, "canViewXrays"))) {
      return NextResponse.json({ message: "غير مصرّح لك بعرض هذا المستند." }, { status: 403 });
    }
    if (found.document.removedAt && !isAdmin(session.role)) {
      return NextResponse.json({ message: "المستند مخفيّ." }, { status: 404 });
    }

    const bytes = await readFileByKey(found.storageKey);
    if (!bytes) {
      // الصف موجود والملف مفقود: عطلٌ في التخزين لا في الطلب — ويُقال صراحةً بدل
      // صفحةٍ فارغة تجعل الطبيب يظنّ أن الأشعة لم تُرفع أصلًا.
      return NextResponse.json(
        { message: "وصف المستند موجود وملفّه مفقود من التخزين. راجع القرص الملحق." },
        { status: 410 },
      );
    }

    const download = new URL(request.url).searchParams.get("download") === "1";
    const name = encodeURIComponent(found.document.title);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": found.document.mimeType,
        "Content-Length": String(bytes.length),
        // `inline` ليُعرض في الشاشة، و`attachment` حين يُطلب التنزيل صراحةً.
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
        // لا تخزين وسيط: بياناتٌ طبية لا تُترك في ذاكرة وسيطٍ مشترك.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ message: "تعذّر فتح المستند." }, { status: 500 });
  }
}

/** إخفاء مستند — للمدير وحده، وبسببٍ مكتوب. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  /* M2 slice 75: patients.documents.delete inside the patient scope, a written reason, one transaction. */
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    let canonicalBody: Record<string, unknown> = {};
    try { const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); canonicalBody = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>; }
    catch (error) { return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE }); }
    try { return NextResponse.json(await commandCanonicalDocumentHide(selected.handle, (await context.params).id, canonicalBody), { headers: NO_STORE }); }
    catch (error) { return canonicalDocumentFailure(error, "تعذّر إخفاء المستند."); }
  }
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إخفاء المستندات للمدير وحده." }, { status: 403 });
  }
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم المستند غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const note = typeof (body as Record<string, unknown>)?.note === "string"
    ? String((body as Record<string, unknown>).note) : "";

  try {
    const found = await getDocumentForDownload(id);
    const result = await removeDocument({ id, actor: session.username, note });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    void recordAudit({
      action: "document.remove",
      entity: "patient_documents",
      entityId: id,
      entityLabel: found?.document.title ?? null,
      details: { السبب: note.trim().slice(0, 200) },
      actor: session.username,
      actorRole: session.role,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر إخفاء المستند." }, { status: 500 });
  }
}
