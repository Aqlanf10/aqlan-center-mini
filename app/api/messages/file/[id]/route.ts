import { NextResponse } from "next/server";
import { fileMessagePayload } from "@/lib/db";
import { requireSessionStrict } from "@/lib/session";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/**
 * جسم مرفق رسالة — لطاقم العيادة ومرضاها معًا، كلٌّ بتحقّق وصوله.
 *
 * نفس أسوار جسم الصوت: التحقق قبل فكّ البايت الأول، والمرفق الخاص بين زميلين
 * لا يصل لثالث، ومرفق خيط المريض للطاقم جميعًا وصاحبه وحده من البوابة. الصور
 * تُعرض داخل المحادثة (inline) وPDF يُنزَّل ملفًّا — فالمرفق الطبي وثيقةٌ
 * تُحفظ لا صورةٌ تُتصفح.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const messageId = Number(id);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return NextResponse.json({ message: "مرفق غير صالح." }, { status: 400 });
  }

  const payload = await fileMessagePayload(messageId);
  if (!payload) {
    return NextResponse.json({ message: "المرفق غير موجود." }, { status: 404 });
  }

  const portal = await requirePortalSession();
  if (portal) {
    const mine = payload.senderPatientId === portal.patientId
      || payload.recipientPatientId === portal.patientId;
    if (!mine) {
      return NextResponse.json({ message: "لا يمكنك الوصول إلى هذا الملف." }, { status: 403 });
    }
    return fileResponse(payload.mime, payload.data, payload.name);
  }

  const session = await requireSessionStrict();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول للوصول إلى الملف." }, { status: 401 });
  }

  if (payload.senderType === "user" && payload.recipientType === "user") {
    const participant = payload.senderUserId === session.userId
      || payload.recipientUserId === session.userId;
    if (!participant) {
      return NextResponse.json(
        { message: "هذا مرفق رسالة خاصة بين زميلين." },
        { status: 403 },
      );
    }
  }

  return fileResponse(payload.mime, payload.data, payload.name);
}

function fileResponse(mime: string, base64: string, name: string | null): NextResponse {
  const buffer = Buffer.from(base64, "base64");
  const isImage = mime.startsWith("image/");
  // الاسم في الرأس يُرمَّز UTF-8 الممتد فتصل الأسماء العربية سليمة، ولا يدخل
  // الرأس أي محرف تحكم — sanitizeFileName كفلت ذلك عند الإدراج.
  const encodedName = encodeURIComponent(name ?? "attachment");
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `${isImage ? "inline" : "attachment"}; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "none",
    },
  });
}
