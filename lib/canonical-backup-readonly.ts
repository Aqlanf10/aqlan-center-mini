import "server-only";
import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "./security-limits";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { messagingChannelWithSecret, recordChannelTest, recordMessageDelivery } from "./db";
import { isChannel } from "./messaging-channels";
import { sendOutbound } from "./messaging-send";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { admitCanonicalOwnerReadOnly, withCanonicalOwnerOperation } from "./staff-session-admission";

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

  const admitted = await withCanonicalOwnerOperation(
    session,
    "settings.integrations.change",
    async (_client, view) => view,
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
  if (precheck instanceof NextResponse) return precheck;

  try {
    const result = await sendOutbound(
      {
        channel: precheck.channel,
        to: precheck.to,
        subject: "رسالة اختبار",
        body: "رسالة اختبار من نظام المركز — القناة تعمل.",
        patientId: null,
        purpose: "test",
        actor: admitted.value.username,
      },
      { channel: messagingChannelWithSecret, record: recordMessageDelivery },
    );
    await recordChannelTest(precheck.channel, result.ok, result.ok ? "نجح الاختبار" : result.message);
    return result.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, message: result.message }, { status: result.status });
  } catch {
    return NextResponse.json({ message: "تعذّر اختبار القناة." }, { status: 500 });
  }
}
