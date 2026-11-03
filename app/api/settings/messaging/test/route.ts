import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  ensureSchema,
  getPool,
  messagingChannelWithSecretWith,
  recordChannelTestWith,
  recordMessageDeliveryWith,
} from "@/lib/db";
import { withTransaction } from "@/lib/transactions";
import {
  claimOutboundIdempotencyInTx,
  completeOutboundIdempotency,
  releaseOutboundReservation,
} from "@/lib/http-idempotency";
import { isChannel } from "@/lib/messaging-channels";
import { sendOutbound } from "@/lib/messaging-send";
import { isAdmin } from "@/lib/roles";
import { requireSession, revalidateSessionInTransaction } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalMessagingTestPost } from "@/lib/canonical-backup-readonly";

export const dynamic = "force-dynamic";

const MESSAGING_TEST_IDEMPOTENCY_SCOPE = "settings.messaging.test";

/** (MSG-1) إرسال رسالة اختبار عبر قناة — ولو قبل تفعيلها — وتسجيل نتيجته في القناة. للمدير وحده. */
export async function POST(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (selected.kind === "canonical") return canonicalMessagingTestPost(selected.handle, request);

  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!isAdmin(session.role)) return NextResponse.json({ message: "اختبار القنوات للمدير وحده." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  if (!isChannel(body.channel)) return NextResponse.json({ message: "قناة غير معروفة." }, { status: 400 });
  const channel = body.channel;
  const to = typeof body.to === "string" ? body.to.trim().slice(0, 200) : "";
  if (!to) return NextResponse.json({ message: "أدخل رقمًا أو بريدًا لرسالة الاختبار." }, { status: 400 });
  const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId : null;

  try {
    await ensureSchema();
    const pool = getPool();
    const outboundActor = `legacy:${session.userId}`;
    const preflight = await withTransaction(pool, async (client) => {
      const current = await revalidateSessionInTransaction(session, client);
      if (!current) return { kind: "unauth" as const };
      if (!isAdmin(current.role)) return { kind: "forbidden" as const };
      const reservation = await claimOutboundIdempotencyInTx(
        client,
        request,
        MESSAGING_TEST_IDEMPOTENCY_SCOPE,
        outboundActor,
        { channel, to },
        clientRequestId,
      );
      if (reservation.kind === "conflict") {
        return { kind: "conflict" as const, status: reservation.status, body: reservation.body };
      }
      if (reservation.kind === "replay") {
        return { kind: "replay" as const, status: reservation.status, body: reservation.body };
      }
      return {
        kind: "ready" as const,
        actor: current.username,
        reservation: reservation.kind === "reserved" ? reservation : null,
      };
    });
    if (preflight.kind === "unauth") {
      return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
    }
    if (preflight.kind === "forbidden") {
      return NextResponse.json({ message: "اختبار القنوات للمدير وحده." }, { status: 403 });
    }
    if (preflight.kind === "conflict") {
      return NextResponse.json(preflight.body, { status: preflight.status });
    }
    if (preflight.kind === "replay") {
      return NextResponse.json(preflight.body, {
        status: preflight.status,
        headers: { "Cache-Control": "no-store", "X-Idempotent-Replay": "true" },
      });
    }

    const reserved = preflight.reservation;
    const release = async () => {
      if (reserved) {
        await releaseOutboundReservation(pool, MESSAGING_TEST_IDEMPOTENCY_SCOPE, outboundActor, reserved.key, reserved.requestHash);
      }
    };

    const fresh = await withTransaction(pool, async (client) => {
      const current = await revalidateSessionInTransaction(session, client);
      if (!current) return { kind: "unauth" as const };
      if (!isAdmin(current.role)) return { kind: "forbidden" as const };
      return {
        kind: "ok" as const,
        channelData: await messagingChannelWithSecretWith(client, channel),
      };
    });
    if (fresh.kind !== "ok") {
      await release();
      return fresh.kind === "unauth"
        ? NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 })
        : NextResponse.json({ message: "اختبار القنوات للمدير وحده." }, { status: 403 });
    }

    const result = await sendOutbound(
      {
        channel,
        to,
        subject: "رسالة اختبار",
        body: "رسالة اختبار من نظام المركز — القناة تعمل.",
        patientId: null,
        purpose: "test",
        actor: preflight.actor,
      },
      {
        channel: async () => ({ view: fresh.channelData.view, secret: fresh.channelData.secret }),
        record: (inp) => recordMessageDeliveryWith(pool, inp),
      },
    );
    let channelRecorded = true;
    try {
      await recordChannelTestWith(pool, channel, result.ok, result.ok ? "نجح الاختبار" : result.message);
    } catch {
      channelRecorded = false;
    }

    const responseStatus = result.ok ? 200 : result.status;
    const responseBody = result.ok
      ? {
          ok: true,
          ...(result.logged && channelRecorded
            ? {}
            : { message: "أُرسلت رسالة الاختبار، لكن تعذّر تحديث سجل القناة — لا تُعد الإرسال." }),
        }
      : { ok: false, message: result.message };

    if (reserved) {
      if (!result.ok && (result.status === 400 || result.status === 409)) {
        await release();
      } else {
        await completeOutboundIdempotency(
          pool,
          MESSAGING_TEST_IDEMPOTENCY_SCOPE,
          outboundActor,
          reserved.key,
          responseStatus,
          responseBody,
        );
      }
    }

    return NextResponse.json(responseBody, { status: responseStatus });
  } catch {
    return NextResponse.json({ message: "تعذّر اختبار القناة." }, { status: 500 });
  }
}
