import { NextResponse } from "next/server";
import {
  broadcastMessages,
  directMessages,
  getPatient,
  getStaffUserById,
  insertMessage,
  markConversationRead,
  patientThreadMessages,
  staffConversationList,
  unreadMessageCount,
} from "@/lib/db";
import { parseMessageTarget, validateOutgoingMessage } from "@/lib/messages";
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
      const [list, unread] = await Promise.all([
        staffConversationList(session.userId),
        unreadMessageCount(session.userId),
      ]);
      return NextResponse.json({ ...list, unread, meUserId: session.userId });
    }

    if (url.searchParams.get("unread") === "1") {
      return NextResponse.json({ unread: await unreadMessageCount(session.userId) });
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
    });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إرسال الرسالة." }, { status: 500 });
  }
}
