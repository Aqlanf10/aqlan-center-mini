import { NextResponse } from "next/server";
import {
  countRecentPatientMessages,
  deletePatientMessage,
  editPatientMessage,
  getPatient,
  insertMessage,
  markPatientThreadReadByPatient,
  patientThreadMessages,
  recordAudit,
} from "@/lib/db";
import {
  parseMessageId,
  PORTAL_MESSAGE_HOUR_LIMIT,
  validateMessageEdit,
  validateOutgoingMessage,
} from "@/lib/messages";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/**
 * مراسلة المريض مع العيادة من البوابة — نصًا وصوتًا ومرفقات.
 *
 * رسائل المريض تصل إلى صندوق الطاقم كله (staff_all): لا حاجة لأن يعرف المريض
 * من يجيب، ومن يفتح الخيط أولًا يجد الرسالة. ومعرّف المريض من الجلسة الموقّعة
 * وحدها — لا من الطلب. وحدّ المعدل يمنع إغراق الصندوق المشترك برسائل آلية
 * أو عابثة فتطمس رسائل المرضى الحقيقيين. وفتح الخيط هنا قراءةٌ لردّ الطاقم
 * فتظهر عند المرسِل علامة الصحّين.
 */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  try {
    const messages = await patientThreadMessages(session.patientId);
    await markPatientThreadReadByPatient(session.patientId);
    return NextResponse.json({ messages });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المحادثة." }, { status: 500 });
  }
}

/**
 * إرسال رسالة من المريض — مع علامة العاجلة واقتباس الردّ.
 *
 * العاجلة للمريض وحده: طلبٌ يشعلها فيرتفع صوت العيادة كلها (نغمة أصرخ وبانر
 * أحمر وقائمة تتصدرها الخيوط الحارقة)، ولا يملكها أحد غيره لأن عاجلة الطاقم
 * بعضهم إلى بعض هراءٌ إداري لا استغاثة مريض.
 */
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
      isUrgent: message.urgent,
      replyToId: message.replyToId,
    });
    await recordAudit({
      action: "portal.message",
      entity: "patient",
      entityId: session.patientId,
      details: {
        kind: message.kind,
        urgent: message.urgent,
        replyTo: message.replyToId,
        chars: message.body?.length ?? 0,
        fileName: message.fileName,
        fileSize: message.fileSize,
      },
      actor: `بوابة المريض: ${session.fullName}`,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "reply-out-of-thread") {
      return NextResponse.json(
        { message: "لا يُردّ إلا على رسالة من محادثتك مع العيادة." },
        { status: 400 },
      );
    }
    return NextResponse.json({ message: "تعذّر إرسال الرسالة." }, { status: 500 });
  }
}

/** تعديل رسالتي النصية من البوابة — بختم «معدّلة» أمام الطاقم. */
export async function PATCH(request: Request) {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const verdict = validateMessageEdit((body ?? {}) as Record<string, unknown>);
  if (!verdict.ok) {
    return NextResponse.json({ message: verdict.message }, { status: 400 });
  }

  try {
    const result = await editPatientMessage(
      verdict.value.messageId, session.patientId, verdict.value.body,
    );
    if (!result.ok) {
      return NextResponse.json(
        { message: "لا يمكن تعديل هذه الرسالة — النصية غير المحذوفة لك وحدك." },
        { status: 403 },
      );
    }
    return NextResponse.json(result.message);
  } catch {
    return NextResponse.json({ message: "تعذّر تعديل الرسالة." }, { status: 500 });
  }
}

/** حذف رسالتي حذفًا لطيفًا — يبقى أثرها «حُذفت هذه الرسالة» في الخيط. */
export async function DELETE(request: Request) {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }

  const url = new URL(request.url);
  let id = parseMessageId(url.searchParams.get("id"));
  if (id === null) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      id = parseMessageId(body?.id);
    } catch {
      id = null;
    }
  }
  if (id === null) {
    return NextResponse.json({ message: "رسالة غير صالحة." }, { status: 400 });
  }

  try {
    const result = await deletePatientMessage(id, session.patientId);
    if (!result.ok) {
      return NextResponse.json(
        { message: "لا يمكن حذف هذه الرسالة — رسائلك المرسلة وحدك." },
        { status: 403 },
      );
    }
    return NextResponse.json(result.message);
  } catch {
    return NextResponse.json({ message: "تعذّر حذف الرسالة." }, { status: 500 });
  }
}
