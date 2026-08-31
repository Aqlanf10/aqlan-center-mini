import { NextResponse } from "next/server";
import { voiceMessagePayload } from "@/lib/db";
import { requireSessionStrict } from "@/lib/session";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/**
 * جسم رسالة صوتية — لطاقم العيادة ومرضاها معًا، كلٌّ بتحقّق وصوله.
 *
 * التحقق قبل فكّ البايت الأول لا بعده: الرسالة المباشرة بين زميلين لا يسمعها
 * غيرهما مهما كان دوره، وخيط المريض يسمعه الطاقم جميعًا (الصندوق مشترك) وصاحبه
 * وحده من جهة البوابة.
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

  const payload = await voiceMessagePayload(messageId);
  if (!payload) {
    return NextResponse.json({ message: "الرسالة الصوتية غير موجودة." }, { status: 404 });
  }

  const portal = await requirePortalSession();
  if (portal) {
    const mine = payload.senderPatientId === portal.patientId
      || payload.recipientPatientId === portal.patientId;
    if (!mine) {
      return NextResponse.json({ message: "لا يمكنك سماع هذه الرسالة." }, { status: 403 });
    }
    return audioResponse(payload.mime, payload.data);
  }

  const session = await requireSessionStrict();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول لسماع الرسالة." }, { status: 401 });
  }

  if (payload.senderType === "user" && payload.recipientType === "user") {
    const participant = payload.senderUserId === session.userId
      || payload.recipientUserId === session.userId;
    if (!participant) {
      return NextResponse.json(
        { message: "هذه رسالة خاصة بين زميلين." },
        { status: 403 },
      );
    }
  }

  return audioResponse(payload.mime, payload.data);
}

function audioResponse(mime: string, base64: string): NextResponse {
  const buffer = Buffer.from(base64, "base64");
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "private, max-age=86400",
      "Accept-Ranges": "none",
    },
  });
}
