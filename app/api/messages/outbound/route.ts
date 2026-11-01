import { NextResponse } from "next/server";
import { NO_STORE } from "@/lib/canonical-patient-http";
import {
  messagesOutboundGetCanonicalResponse,
  messagesOutboundPostCanonicalResponse,
} from "@/lib/canonical-messages-tasks";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { ensureSchema, getPatient, getPool, isVerifiedInboundReply, listMessageDeliveries, messagingChannelWithSecret, patientIdsForOutboundRecipient, patientMessagingConsent, recordAudit, recordMessageDelivery } from "@/lib/db";
import { claimOutboundIdempotencyInTx, completeOutboundIdempotency, releaseOutboundReservation } from "@/lib/http-idempotency";
import { withTransaction } from "@/lib/transactions";
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
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") return messagesOutboundGetCanonicalResponse(request, selected.handle);

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
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") return messagesOutboundPostCanonicalResponse(request, selected.handle);

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
  let patient = Number.isInteger(patientId) && patientId > 0 ? await getPatient(patientId).catch(() => null) : null;
  if (body.patientId !== undefined && body.patientId !== null && !patient) {
    return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });
  }
  const typed = typeof body.to === "string" ? body.to.trim().slice(0, 200) : "";
  const to = typed || (channel !== "email" ? patient?.phone ?? "" : patient?.email ?? "");
  if (!to) return NextResponse.json({ message: channel === "email" ? "لا بريد لهذا المريض — أدخل بريد المستلم." : "لا رقم جوال لهذا المريض — أدخل الرقم." }, { status: 400 });

  try {
    const matchingPatients = await patientIdsForOutboundRecipient(channel, to);
    if (patient && matchingPatients.length > 0 && !matchingPatients.includes(patient.id)) {
      return NextResponse.json({ message: "وسيلة التواصل تخص مريضًا آخر؛ اختر ملف المستلم الصحيح." }, { status: 409 });
    }
    if (!patient && matchingPatients.length > 1) {
      return NextResponse.json({ message: "وسيلة التواصل مشتركة بين مرضى؛ اختر ملف المريض قبل الإرسال." }, { status: 409 });
    }
    if (!patient && matchingPatients.length === 1) patient = await getPatient(matchingPatients[0]);
  } catch {
    return NextResponse.json({ message: "تعذّر التحقق من موافقة المستلم." }, { status: 500 });
  }

  const outboundSubject = typeof body.subject === "string" ? body.subject.slice(0, 200) : null;
  const outboundBody = typeof body.body === "string" ? body.body : "";
  const outboundPurpose = body.purpose === "reply" ? "reply" as const : "manual" as const;
  const outboundReplyTo = typeof body.replyToInboundId === "number" ? body.replyToInboundId : null;
  const outboundActor = `legacy:${session.userId}`;
  // Peer-review #3/#5: durable reservation before external transport; never re-send on
  // an uncertain outcome.
  let reservation: Awaited<ReturnType<typeof claimOutboundIdempotencyInTx>>;
  try {
    await ensureSchema();
    reservation = await withTransaction(getPool(), (client) => claimOutboundIdempotencyInTx(
      client, request, OUTBOUND_SCOPE, outboundActor,
      { channel, to, subject: outboundSubject, body: outboundBody, patientId: patient?.id ?? null, purpose: outboundPurpose, replyToInboundId: outboundReplyTo },
      typeof body.clientRequestId === "string" ? body.clientRequestId : null,
    ));
  } catch {
    return NextResponse.json({ message: "تعذّر إرسال الرسالة." }, { status: 500 });
  }
  if (reservation.kind === "conflict") return NextResponse.json(reservation.body, { status: reservation.status });
  if (reservation.kind === "replay") {
    return NextResponse.json(reservation.body, { status: reservation.status, headers: { "X-Idempotent-Replay": "true" } });
  }
  const reserved = reservation.kind === "reserved" ? reservation : null;

  try {
    const result = await sendOutbound(
      {
        channel, to, subject: outboundSubject,
        body: outboundBody, patientId: patient?.id ?? null,
        purpose: outboundPurpose, actor: session.username,
        replyToInboundId: outboundReplyTo,
      },
      {
        channel: messagingChannelWithSecret, record: recordMessageDelivery, consent: patientMessagingConsent,
        verifyReply: (message) => isVerifiedInboundReply({
          inboundId: message.replyToInboundId!, channel: message.channel,
          patientId: message.patientId, to: message.to,
        }),
      },
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
    const responseBody = result.ok
      ? { ok: true, deliveryId: result.deliveryId,
        ...(result.logged ? {} : { message: "أُرسلت الرسالة، لكن تعذّر حفظها في السجل — لا تُعد إرسالها." }) }
      : { ok: false, message: result.message, deliveryId: result.deliveryId };
    const responseStatus = result.ok ? 201 : result.status;
    if (reserved) {
      if (!result.ok && (result.status === 400 || result.status === 409)) {
        await releaseOutboundReservation(getPool(), OUTBOUND_SCOPE, outboundActor, reserved.key, reserved.requestHash);
      } else {
        await completeOutboundIdempotency(getPool(), OUTBOUND_SCOPE, outboundActor, reserved.key, responseStatus, responseBody);
      }
    }
    return NextResponse.json(responseBody, { status: responseStatus });
  } catch {
    // Outcome unknown: the reservation (if any) stays in_progress and fails closed on retry.
    return NextResponse.json({ message: "تعذّر إرسال الرسالة." }, { status: 500 });
  }
}

const OUTBOUND_SCOPE = "messages.outbound";
