import { NextResponse } from "next/server";
import { fileMessagePayload, getMessageAttachmentMeta } from "@/lib/db";
import { isAllowedFileMime } from "@/lib/messages";
import { requireSessionStrict } from "@/lib/session";
import { requirePortalSession } from "@/lib/portal-server";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * جسم مرفق رسالة — لطاقم العيادة ومرضاها معًا، كلٌّ بتحقّق وصوله (F-05).
 *
 * التحقق من الهوية والصلاحية يسبق تحميل بايتات Base64 من القاعدة:
 *  - بلا جلسة صالحة ⇒ 401 دون أي استعلام.
 *  - استعلام وصف الرسالة الخفيف (getMessageAttachmentMeta) يتحقق من الملكية ونطاق الطبيب (403)
 *    قبل استدعاء fileMessagePayload الذي يحمّل بايتات الملف.
 *  - عند التسليم تُفرض القائمة البيضاء الصارمة للأنواع (ALLOWED_FILE_MIMES) فلا يُعرض SVG أو HTML مضمّنًا أبدًا.
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

  const [portal, session] = await Promise.all([requirePortalSession(), requireSessionStrict()]);
  if (!portal && !session) {
    return NextResponse.json({ message: "سجّل الدخول للوصول إلى الملف." }, { status: 401 });
  }

  const meta = await getMessageAttachmentMeta(messageId, "file");
  if (!meta) {
    return NextResponse.json({ message: "المرفق غير موجود." }, { status: 404 });
  }

  let authorized = false;

  if (portal) {
    const mine = meta.senderPatientId === portal.patientId
      || meta.recipientPatientId === portal.patientId;
    if (mine) {
      authorized = true;
    } else if (!session) {
      return NextResponse.json({ message: "لا يمكنك الوصول إلى هذا الملف." }, { status: 403 });
    }
  }

  if (!authorized) {
    if (!session) {
      return NextResponse.json({ message: "سجّل الدخول للوصول إلى الملف." }, { status: 401 });
    }

    if (meta.senderType === "user" && meta.recipientType === "user") {
      const participant = meta.senderUserId === session.userId
        || meta.recipientUserId === session.userId;
      if (!participant) {
        return NextResponse.json(
          { message: "هذا مرفق رسالة خاصة بين زميلين." },
          { status: 403 },
        );
      }
    }

    const patientId = meta.recipientPatientId ?? meta.senderPatientId;
    const normalizedMetaMime = meta.mime.trim().toLowerCase();
    const requiredPerm = isAllowedFileMime(normalizedMetaMime) && normalizedMetaMime.startsWith("image/")
      ? "canViewXrays"
      : undefined;
    if (patientId && !(await canAccessPatient(session, patientId, requiredPerm))) {
      return NextResponse.json(
        { message: "غير مصرّح لك بالوصول إلى مرفقات هذا المريض." },
        { status: 403 },
      );
    }
  }

  const payload = await fileMessagePayload(messageId);
  if (!payload) {
    return NextResponse.json({ message: "المرفق غير موجود." }, { status: 404 });
  }

  return fileResponse(payload.mime, payload.data, payload.name);
}

function fileResponse(mime: string, base64: string, name: string | null): NextResponse {
  const buffer = Buffer.from(base64, "base64");
  const normalizedMime = mime.trim().toLowerCase();
  const safeMime = isAllowedFileMime(normalizedMime)
    ? normalizedMime
    : "application/octet-stream";
  const isSafeInlineImage = safeMime !== "application/octet-stream" && safeMime.startsWith("image/");
  const encodedName = encodeURIComponent(name ?? "attachment");
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": safeMime,
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `${isSafeInlineImage ? "inline" : "attachment"}; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "none",
    },
  });
}
