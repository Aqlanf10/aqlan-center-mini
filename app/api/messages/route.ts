import { NextResponse } from "next/server";
import {
  broadcastMessages,
  deleteStaffMessage,
  directMessages,
  editStaffMessage,
  getPatient,
  getStaffUserById,
  insertMessage,
  markConversationRead,
  patientThreadMessages,
  staffConversationList,
  unreadMessageCount,
  urgentUnreadMessageCount,
} from "@/lib/db";
import {
  parseMessageId,
  parseMessageTarget,
  validateMessageEdit,
  validateOutgoingMessage,
} from "@/lib/messages";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * المراسلة الداخلية للطاقم — قراءة المحادثات وإرسال الرسائل النصية والصوتية.
 *
 * قائمة المحادثات تجمع زملاء الطاقم النشطين (مع من لم تسبق محادثته — لتبدأ من
 * الشاشة نفسها) وخيوط المرضى الذين في خيطهم رسالة. جسم الصوت لا يُحمّل هنا:
 * يُجلب عند التشغيل من مساره الخاص بعد تحقق الوصول.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  const url = new URL(request.url);

  try {
    if (url.searchParams.get("conversations") === "1") {
      const [list, unread, urgent] = await Promise.all([
        staffConversationList(session.userId),
        unreadMessageCount(session.userId),
        urgentUnreadMessageCount(session.userId),
      ]);
      return NextResponse.json({ ...list, unread, urgent, meUserId: session.userId });
    }

    if (url.searchParams.get("unread") === "1") {
      const [unread, urgent] = await Promise.all([
        unreadMessageCount(session.userId),
        urgentUnreadMessageCount(session.userId),
      ]);
      return NextResponse.json({ unread, urgent });
    }

    const withUser = Number(url.searchParams.get("withUser"));
    const withPatient = Number(url.searchParams.get("withPatient"));

    if (url.searchParams.get("broadcast") === "1") {
      const messages = await broadcastMessages();
      await markConversationRead(session.userId, { broadcast: true });
      return NextResponse.json({ messages });
    }

    if (Number.isInteger(withUser) && withUser > 0) {
      const messages = await directMessages(session.userId, withUser);
      await markConversationRead(session.userId, { withUserId: withUser });
      return NextResponse.json({ messages });
    }

    if (Number.isInteger(withPatient) && withPatient > 0) {
      const messages = await patientThreadMessages(withPatient);
      await markConversationRead(session.userId, { withPatientId: withPatient });
      return NextResponse.json({ messages });
    }

    return NextResponse.json({ message: "حدّد المحادثة المطلوبة." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المحادثة." }, { status: 500 });
  }
}

/**
 * إرسال رسالة من عضو طاقم — إلى زميل، أو إلى مريض في خيطه، أو بثًّا للفريق كله.
 *
 * الإذن واحد لكل الأدوار: المراسلة عمل الطاقم كله. والجهة تُتحقق قبل الإدراج
 * (زميل نشط أو مريض موجود) فلا تصل رسالة إلى صندوق مهجور. والبثّ الجماعي
 * صفٌّ واحد يراه الجميع — لا نسخة لكل زميل فتتضخم المرفقات في القاعدة.
 * والردّ يقتبس رسالةً من الخيط نفسه — الاقتباس من محادثة أخرى مرفوض هنا.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const target = parseMessageTarget(source.to);
  if (!target) {
    return NextResponse.json({ message: "جهة الرسالة غير صالحة." }, { status: 400 });
  }

  const verdict = validateOutgoingMessage(target, source);
  if (!verdict.ok) {
    return NextResponse.json({ message: verdict.message }, { status: 400 });
  }
  const message = verdict.value;

  if (target.type === "user") {
    const recipient = await getStaffUserById(target.id!);
    if (!recipient || !recipient.isActive) {
      return NextResponse.json({ message: "الزميل غير موجود أو غير مفعّل." }, { status: 404 });
    }
  } else if (target.type === "patient") {
    const patient = await getPatient(target.id!);
    if (!patient) {
      return NextResponse.json({ message: "ملف المريض غير موجود." }, { status: 404 });
    }
  } else if (target.type === "staff_all") {
    return NextResponse.json(
      { message: "المرسل من الطاقم يخاطب زميلًا أو مريضًا — صندوق المرضى للبوابة." },
      { status: 400 },
    );
  }

  try {
    const created = await insertMessage({
      senderType: "user",
      senderUserId: session.userId,
      senderPatientId: null,
      recipientType: target.type === "staff_broadcast" ? "staff_all" : target.type,
      recipientUserId: target.type === "user" ? target.id! : null,
      recipientPatientId: target.type === "patient" ? target.id! : null,
      body: message.body,
      kind: message.kind,
      voiceMime: message.voiceMime,
      voiceData: message.voiceData,
      voiceMs: message.voiceMs,
      fileName: message.fileName,
      fileMime: message.fileMime,
      fileSize: message.fileSize,
      fileData: message.fileData,
      replyToId: message.replyToId,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "reply-out-of-thread") {
      return NextResponse.json(
        { message: "لا يُردّ إلا على رسالة من المحادثة نفسها." },
        { status: 400 },
      );
    }
    return NextResponse.json({ message: "تعذّر إرسال الرسالة." }, { status: 500 });
  }
}

/**
 * تعديل رسالتي النصية — نصّ جديد باقٍ في مكانه بختم «معدّلة».
 *
 * الملكية والنوع والعدم حذفها شروطٌ في سطر التحديث نفسه، فمحاولة تعديل كلام
 * زميل أو رسالة صوتية تفشل بnot-allowed لا برسالة غامضة.
 */
export async function PATCH(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const verdict = validateMessageEdit((body ?? {}) as Record<string, unknown>);
  if (!verdict.ok) {
    return NextResponse.json({ message: verdict.message }, { status: 400 });
  }

  try {
    const result = await editStaffMessage(verdict.value.messageId, session.userId, verdict.value.body);
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

/**
 * حذف رسالتي حذفًا لطيفًا — يبقى قبرها ظاهرًا «حُذفت هذه الرسالة» فلا يُنكر
 * الخيط أن كلامًا قيل فيه، ويبقى اقتباس الردود عليها شاهدًا على مكانها.
 */
export async function DELETE(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

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
    const result = await deleteStaffMessage(id, session.userId);
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
