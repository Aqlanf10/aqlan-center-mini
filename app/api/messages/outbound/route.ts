import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getPatient, listMessageDeliveries, messagingChannelWithSecret, recordAudit, recordMessageDelivery } from "@/lib/db";
import { isChannel } from "@/lib/messaging-channels";
import { sendOutbound } from "@/lib/messaging-send";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (MSG-1) رسائل المرضى عبر القنوات الخارجية — واتساب، الرسائل النصية، البريد.
 *
 * GET: سجل الرسائل (لمريضٍ بعينه أو للكل) — للمدير والاستقبال.
 * POST: إرسال رسالة لمريض (رقمه من ملفه إن لم يُكتب) أو لرقمٍ/بريدٍ مباشر، وتسجيلها.
 */

const STAFF = new Set(["admin", "reception"]);

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!STAFF.has(session.role)) return NextResponse.json({ message: "سجل الرسائل للإدارة والاستقبال." }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const patientId = Number(params.get("patientId"));
  const channel = params.get("channel");
  try {
    const rows = await listMessageDeliveries({
      patientId: Number.isInteger(patientId) && patientId > 0 ? patientId : null,
      channel: isChannel(channel) ? channel : null,
      limit: 200,
    });
    return NextResponse.json({ rows });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجل الرسائل." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!STAFF.has(session.role)) return NextResponse.json({ message: "إرسال الرسائل للمرضى للإدارة والاستقبال." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  if (!isChannel(body.channel)) return NextResponse.json({ message: "اختر القناة: واتساب أو رسالة نصية أو بريد." }, { status: 400 });
  const channel = body.channel;
  const patientId = Number(body.patientId);
  const patient = Number.isInteger(patientId) && patientId > 0 ? await getPatient(patientId).catch(() => null) : null;
  if (body.patientId !== undefined && body.patientId !== null && !patient) {
    return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
  }
  const typed = typeof body.to === "string" ? body.to.trim().slice(0, 200) : "";
  const to = typed || (channel !== "email" ? patient?.phone ?? "" : "");
  if (!to) return NextResponse.json({ message: channel === "email" ? "أدخل بريد المستلم." : "لا رقم جوال لهذا المريض — أدخل الرقم." }, { status: 400 });

  try {
    const result = await sendOutbound(
      {
        channel, to, subject: typeof body.subject === "string" ? body.subject.slice(0, 200) : null,
        body: typeof body.body === "string" ? body.body : "", patientId: patient?.id ?? null,
        purpose: body.purpose === "reply" ? "reply" : "manual", actor: session.username,
      },
      { channel: messagingChannelWithSecret, record: recordMessageDelivery },
    );
    await recordAudit({
      action: "messaging.send",
      entity: patient ? "patient" : "message_delivery",
      entityId: patient?.id ?? result.deliveryId,
      entityLabel: patient?.fullName ?? channel,
      details: { channel, ok: result.ok },
      actor: session.username,
      actorRole: session.role,
    });
    return result.ok
      ? NextResponse.json({
        ok: true, deliveryId: result.deliveryId,
        ...(result.logged ? {} : { message: "أُرسلت الرسالة، لكن تعذّر حفظها في السجل — لا تُعد إرسالها." }),
      }, { status: 201 })
      : NextResponse.json({ ok: false, message: result.message, deliveryId: result.deliveryId }, { status: result.status });
  } catch {
    return NextResponse.json({ message: "تعذّر إرسال الرسالة." }, { status: 500 });
  }
}
