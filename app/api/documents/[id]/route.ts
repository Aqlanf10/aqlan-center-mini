import { NextResponse } from "next/server";
import { getDocumentForDownload, recordAudit, removeDocument } from "@/lib/db";
import { readFileByKey } from "@/lib/files";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

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
  const session = await requireSession();
  if (!session) return denied();
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم المستند غير صالح." }, { status: 400 });

  try {
    const found = await getDocumentForDownload(id);
    if (!found) return NextResponse.json({ message: "المستند غير موجود." }, { status: 404 });
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
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إخفاء المستندات للمدير وحده." }, { status: 403 });
  }
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم المستند غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await request.json(); } catch {
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
