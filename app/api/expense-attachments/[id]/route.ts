import { NextResponse } from "next/server";
import { getExpenseAttachment } from "@/lib/db";
import { readFileByKey } from "@/lib/files";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P3-6) عرض مرفق سند صرف — بجلسةٍ مالية لا برابطٍ عام، كالمستندات تمامًا:
 * المتصفّح يعرف رقم المرفق فقط، ومفتاح التخزين لا يخرج إليه.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم المرفق غير صالح." }, { status: 400 });
  }
  try {
    const found = await getExpenseAttachment(id);
    if (!found) return NextResponse.json({ message: "المرفق غير موجود." }, { status: 404 });
    const bytes = await readFileByKey(found.storageKey);
    if (!bytes) {
      return NextResponse.json(
        { message: "وصف المرفق موجود وملفّه مفقود من التخزين. راجع القرص الملحق." },
        { status: 410 },
      );
    }
    const download = new URL(request.url).searchParams.get("download") === "1";
    const name = encodeURIComponent(found.attachment.title);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": found.attachment.mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ message: "تعذّر فتح المرفق." }, { status: 500 });
  }
}
