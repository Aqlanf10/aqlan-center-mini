import { NextResponse } from "next/server";
import { insertMessage, patientThreadMessages, recordAudit } from "@/lib/db";
import { validateOutgoingMessage } from "@/lib/messages";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/**
 * مراسلة المريض مع العيادة من البوابة.
 *
 * رسائل المريض تصل إلى صندوق الطاقم كله (staff_all): لا حاجة لأن يعرف المريض
 * من يجيب، ومن يفتح الخيط أولًا يجد الرسالة. ومعرّف المريض من الجلسة الموقّعة
 * وحدها — لا من الطلب.
 */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  try {
    return NextResponse.json({ messages: await patientThreadMessages(session.patientId) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المحادثة." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const verdict = validateOutgoingMessage({ type: "staff_all" }, source);
  if (!verdict.ok) {
    return NextResponse.json({ message: verdict.message }, { status: 400 });
  }
  const message = verdict.value;

  try {
    const created = await insertMessage({
      senderType: "patient",
      senderUserId: null,
      senderPatientId: session.patientId,
      recipientType: "staff_all",
      recipientUserId: null,
      recipientPatientId: null,
      body: message.body,
      kind: message.kind,
      voiceMime: message.voiceMime,
      voiceData: message.voiceData,
      voiceMs: message.voiceMs,
    });
    await recordAudit({
      action: "portal.message",
      entity: "patient",
      entityId: session.patientId,
      details: { kind: message.kind, chars: message.body?.length ?? 0 },
      actor: `بوابة المريض: ${session.fullName}`,
    });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إرسال الرسالة." }, { status: 500 });
  }
}
