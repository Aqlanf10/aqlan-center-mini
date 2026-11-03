import "server-only";
import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "./security-limits";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import {
  getPool,
  messagingChannelWithSecretWith,
  recordChannelTestWith,
  recordMessageDeliveryWith,
} from "./db";
import {
  claimOutboundIdempotencyInTx,
  completeOutboundIdempotency,
  releaseOutboundReservation,
} from "./http-idempotency";
import { isChannel } from "./messaging-channels";
import { sendOutbound } from "./messaging-send";
import {
  revalidateVerifiedDurableSession,
  type VerifiedDurableSession,
} from "./staff-durable-session";
import {
  admitCanonicalOwnerReadOnly,
  withCanonicalOwnerOperation,
} from "./staff-session-admission";

const MESSAGING_TEST_IDEMPOTENCY_SCOPE = "settings.messaging.test";

const canonicalBackupNoStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Pure READ ONLY canonical owner admission for backup/restore/activation routes.
 * Issues ONLY `BEGIN ... READ ONLY`, `SELECT pg_advisory_xact_lock_shared(...)`,
 * canonical authority `SELECT`s, and `COMMIT` — zero DML, zero DDL, zero `audit_log` writes.
 */
export async function admitCanonicalBackupOwner(
  session: VerifiedDurableSession,
  forbiddenMessage: string,
  unavailableMessage = "المصادقة غير متاحة الآن — يلزم تدخّل يدوي.",
): Promise<{ readonly username: string } | { readonly response: NextResponse }> {
  const admitted = await admitCanonicalOwnerReadOnly(session, "clinic.backup.manage");
  if (!admitted.ok) {
    if (admitted.reason === "forbidden") {
      return { response: canonicalBackupNoStore({ message: forbiddenMessage }, 403) };
    }
    if (admitted.reason === "unavailable") {
      return { response: canonicalBackupNoStore({ message: unavailableMessage }, 503) };
    }
    return { response: canonicalBackupNoStore({ message: "سجّل الدخول من جديد." }, 401) };
  }
  return { username: admitted.view.username };
}

/**
 * Canonical owner-only `POST /api/settings/messaging/test` (AUDIT_EXEMPT: result stored on channel).
 * Reserves a durable outbound idempotency claim before network I/O and never deletes an
 * `in_progress` claim or returns a retry-inducing 500 after external delivery.
 */
export async function canonicalMessagingTestPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  let precheck: { channel: "whatsapp" | "sms" | "email"; to: string } | NextResponse;
  if (!isChannel(body.channel)) {
    precheck = NextResponse.json({ message: "قناة غير معروفة." }, { status: 400 });
  } else {
    const to = typeof body.to === "string" ? body.to.trim().slice(0, 200) : "";
    precheck = to
      ? { channel: body.channel, to }
      : NextResponse.json({ message: "أدخل رقمًا أو بريدًا لرسالة الاختبار." }, { status: 400 });
  }

  const clientRequestId =
    typeof body.clientRequestId === "string" ? body.clientRequestId : null;

  const admitted = await withCanonicalOwnerOperation(
    session,
    "settings.integrations.change",
    async (client, view) => {
      if (precheck instanceof NextResponse) {
        return { kind: "invalid" as const, response: precheck };
      }
      const claims = revalidateVerifiedDurableSession(session);
      const outboundActor = claims
        ? `canon:${claims.durableIdentity.realmId}:${claims.durableIdentity.subjectId}`
        : `canon:user:${view.userId}`;
      const reservation = await claimOutboundIdempotencyInTx(
        client,
        request,
        MESSAGING_TEST_IDEMPOTENCY_SCOPE,
        outboundActor,
        { channel: precheck.channel, to: precheck.to },
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
        username: view.username,
        outboundActor,
        channel: precheck.channel,
        to: precheck.to,
        reservation: reservation.kind === "reserved" ? reservation : null,
      };
    },
  );
  if (!admitted.ok) {
    if (admitted.reason === "forbidden") {
      return NextResponse.json({ message: "اختبار القنوات للمدير وحده." }, { status: 403 });
    }
    if (admitted.reason === "unavailable") {
      return NextResponse.json({ message: "الهوية الموحّدة غير متاحة الآن." }, { status: 503 });
    }
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (admitted.value.kind === "invalid") return admitted.value.response;
  if (admitted.value.kind === "conflict") {
    return NextResponse.json(admitted.value.body, { status: admitted.value.status });
  }
  if (admitted.value.kind === "replay") {
    return NextResponse.json(admitted.value.body, {
      status: admitted.value.status,
      headers: { "Cache-Control": "no-store", "X-Idempotent-Replay": "true" },
    });
  }

  const ready = admitted.value;
  const pool = getPool();
  const reserved = ready.reservation;
  const release = async () => {
    if (reserved) {
      await releaseOutboundReservation(
        pool,
        MESSAGING_TEST_IDEMPOTENCY_SCOPE,
        ready.outboundActor,
        reserved.key,
        reserved.requestHash,
      );
    }
  };

  // Fresh owner authority + channel configuration proof immediately before external transport.
  const fresh = await withCanonicalOwnerOperation(
    session,
    "settings.integrations.change",
    async (client) => messagingChannelWithSecretWith(client, ready.channel),
  );
  if (!fresh.ok) {
    await release();
    if (fresh.reason === "forbidden") {
      return NextResponse.json({ message: "اختبار القنوات للمدير وحده." }, { status: 403 });
    }
    if (fresh.reason === "unavailable") {
      return NextResponse.json({ message: "الهوية الموحّدة غير متاحة الآن." }, { status: 503 });
    }
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  try {
    const result = await sendOutbound(
      {
        channel: ready.channel,
        to: ready.to,
        subject: "رسالة اختبار",
        body: "رسالة اختبار من نظام المركز — القناة تعمل.",
        patientId: null,
        purpose: "test",
        actor: ready.username,
      },
      {
        channel: async () => ({ view: fresh.value.view, secret: fresh.value.secret }),
        record: (inp) => recordMessageDeliveryWith(pool, inp),
      },
    );
    let channelRecorded = true;
    try {
      await recordChannelTestWith(
        pool,
        ready.channel,
        result.ok,
        result.ok ? "نجح الاختبار" : result.message,
      );
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
          ready.outboundActor,
          reserved.key,
          responseStatus,
          responseBody,
        );
      }
    }

    return NextResponse.json(responseBody, {
      status: responseStatus,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ message: "تعذّر اختبار القناة." }, { status: 500 });
  }
}
