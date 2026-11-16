import { NextResponse } from "next/server";
import { inspectRetainedDeletedMessage } from "@/lib/db";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getPortalStaffAccess } from "@/lib/portal-security";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { consumeSecurityLimit } from "@/lib/security-rate-limit";
import { requireSessionStrict } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * معاينة سجل رسالة محذوفة محفوظة في العهدة الآمنة (للمراجعة الإدارية المدققة فقط):
 * - لا يُنفَّذ أي إتلاف نهائي للسجلات قبل اعتماد سياسة الاحتفاظ من المالك.
 * - محصور بالإدارة النشطة ذات النطاق الكامل، ويلزم بسبب مراجعة مكتوب (8 أحرف فأكثر)،
 *   ويسجّل `message.retained.inspect` في `audit_log`.
 */
export async function POST(request: Request) {
  const session = await requireSessionStrict();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json(
      { message: "معاينة سجلات الرسائل المحذوفة المحتفظ بها محصورة بالإدارة المخوّلة." },
      { status: 403 },
    );
  }

  const access = await getPortalStaffAccess(session.userId);
  if (!access || !access.isActive || !access.canInspectRetainedMessages) {
    return NextResponse.json(
      { message: "غير مصرّح لحسابك بمعاينة عهدة الرسائل المحذوفة." },
      { status: 403 },
    );
  }

  const limit = await consumeSecurityLimit({
    scope: "portal-retained-message-inspect",
    identifier: String(session.userId),
    maximum: 15,
    windowMinutes: 15,
    headers: request.headers,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { message: "طلبات متكررة لمعاينة السجلات المحتفظ بها. انتظر قليلًا ثم أعد المحاولة." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfterSeconds)) } },
    );
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const messageId = Number(payload.messageId);
  const reason = typeof payload.reason === "string" ? payload.reason : "";

  try {
    const result = await inspectRetainedDeletedMessage({
      actorSession: session,
      messageId,
      reason,
      includeAttachmentBase64: false,
    });
    if (!result.ok) {
      return NextResponse.json(
        { code: result.code, message: result.message },
        { status: result.status },
      );
    }
    return NextResponse.json({ ok: true, record: result.record });
  } catch {
    return NextResponse.json(
      { message: "تعذّر معاينة السجل المحذوف الآن." },
      { status: 500 },
    );
  }
}
