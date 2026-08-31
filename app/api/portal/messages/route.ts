import { NextResponse } from "next/server";
import {
  countRecentPatientMessages,
  getPatient,
  insertMessage,
  patientThreadMessages,
  recordAudit,
} from "@/lib/db";
import { PORTAL_MESSAGE_HOUR_LIMIT, validateOutgoingMessage } from "@/lib/messages";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/**
 * مراسلة المريض مع العيادة من البوابة — نصًا وصوتًا ومرفقات.
 *
 * رسائل المريض تصل إلى صندوق الطاقم كله (staff_all): لا حاجة لأن يعرف المريض
 * من يجيب، ومن يفتح الخيط أولًا يجد الرسالة. ومعرّف المريض من الجلسة الموقّعة
 * وحدها — لا من الطلب. وحدّ المعدل يمنع إغراق الصندوق المشترك برسائل آلية
 * أو عابثة فتطمس رسائل المرضى الحقيقيين.
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

  // ملفٌ حُذف وتوكنُ جلسته ما زال صالحاً: الجلسة موقّعة فتمرّ، والإدراج يسقط
  // بخطأ مفتاحٍ خارجيّ غامض. الفحص هنا يردّ الجواب الصحيح — انتهت الجلسة
  // لا «تعذّر الإرسال» — ويُغلق باب الخطأ الخامس-المئة عند من حُذف ملفه.
  const patient = await getPatient(session.patientId).catch(() => null);
  if (!patient) {
    return NextResponse.json(
      { message: "انتهت صلاحية جلستك — سجّل الدخول من جديد." },
      { status: 401 },
    );
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
    const recent = await countRecentPatientMessages(session.patientId, 60);
    if (recent >= PORTAL_MESSAGE_HOUR_LIMIT) {
      return NextResponse.json(
        { message: "أرسلت رسائل كثيرة خلال هذه الساعة — انتظر قليلًا ثم أعد المحاولة." },
        { status: 429 },
      );
    }

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
      fileName: message.fileName,
      fileMime: message.fileMime,
      fileSize: message.fileSize,
      fileData: message.fileData,
    });
    await recordAudit({
      action: "portal.message",
      entity: "patient",
      entityId: session.patientId,
      details: {
        kind: message.kind,
        chars: message.body?.length ?? 0,
        fileName: message.fileName,
        fileSize: message.fileSize,
      },
      actor: `بوابة المريض: ${session.fullName}`,
    });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إرسال الرسالة." }, { status: 500 });
  }
}
