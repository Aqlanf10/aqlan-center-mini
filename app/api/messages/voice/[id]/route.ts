import { NextResponse } from "next/server";
import { getMessageAttachmentMeta, voiceMessagePayload } from "@/lib/db";
import { isAllowedVoiceMime, normalizeVoiceMime } from "@/lib/messages";
import { requireSessionStrict } from "@/lib/session";
import { requirePortalSession } from "@/lib/portal-server";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * جسم رسالة صوتية — لطاقم العيادة ومرضاها معًا، كلٌّ بتحقّق وصوله (F-05).
 *
 * التحقق من الصلاحية ونطاق المريض يسبق استدعاء voiceMessagePayload
 * فلا تُحمَّل بايتات الصوت من القاعدة لطلب مرفوض (403)، وتُفرض القائمة البيضاء
 * لأنواع الصوت عند التسليم.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const messageId = Number(id);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return NextResponse.json({ message: "رسالة غير صالحة." }, { status: 400 });
  }

  const [portal, session] = await Promise.all([requirePortalSession(), requireSessionStrict()]);
  if (!portal && !session) {
    return NextResponse.json({ message: "سجّل الدخول لسماع الرسالة." }, { status: 401 });
  }

  const meta = await getMessageAttachmentMeta(messageId, "voice");
  if (!meta) {
    return NextResponse.json({ message: "الرسالة الصوتية غير موجودة." }, { status: 404 });
  }

  let authorized = false;

  if (portal) {
    const mine = meta.senderPatientId === portal.patientId
      || meta.recipientPatientId === portal.patientId;
    if (mine) {
      authorized = true;
    } else if (!session) {
      return NextResponse.json({ message: "لا يمكنك سماع هذه الرسالة." }, { status: 403 });
    }
  }

  if (!authorized) {
    if (!session) {
      return NextResponse.json({ message: "سجّل الدخول لسماع الرسالة." }, { status: 401 });
    }

    if (meta.senderType === "user" && meta.recipientType === "user") {
      const participant = meta.senderUserId === session.userId
        || meta.recipientUserId === session.userId;
      if (!participant) {
        return NextResponse.json(
          { message: "هذه رسالة خاصة بين زميلين." },
          { status: 403 },
        );
      }
    }

    const patientId = meta.recipientPatientId ?? meta.senderPatientId;
    if (patientId && !(await canAccessPatient(session, patientId))) {
      return NextResponse.json(
        { message: "غير مصرّح لك بسماع رسائل هذا المريض." },
        { status: 403 },
      );
    }
  }

  if (meta.isDeleted) {
    return NextResponse.json({ message: "الرسالة الصوتية غير موجودة." }, { status: 404 });
  }

  const payload = await voiceMessagePayload(messageId);
  if (!payload) {
    return NextResponse.json({ message: "الرسالة الصوتية غير موجودة." }, { status: 404 });
  }

  return audioResponse(payload.mime, payload.data);
}

function audioResponse(mime: string, base64: string): NextResponse {
  const buffer = Buffer.from(base64, "base64");
  const normalized = normalizeVoiceMime(mime);
  const safeVoice = isAllowedVoiceMime(normalized);
  const headers: Record<string, string> = {
    "Content-Type": safeVoice ? normalized : "application/octet-stream",
    "Content-Length": String(buffer.byteLength),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "none",
  };
  if (!safeVoice) {
    headers["Content-Disposition"] = "attachment; filename=\"voice-message.bin\"";
  }
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers,
  });
}
