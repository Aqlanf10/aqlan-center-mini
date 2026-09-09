import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { testAiProviderConnection } from "@/lib/ai-providers/registry";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { AI_PROVIDER_TEST_RATE_LIMIT, SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { consumeSecurityLimit } from "@/lib/security-rate-limit";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "اختبار الاتصال للمدير وحده." }, { status: 403 });
  }

  const { id } = await params;

  /* (P2/S10) اختبار الاتصال نداء صادر فعلي إلى مزود — حدّ موزّع لكل مدير
     يمنع الاستنزاف والتكلفة، وبصمة HMAC لا تخزّن مفتاحًا خامًا. */
  const limit = await consumeSecurityLimit({
    scope: "ai-provider-test",
    identifier: session.username,
    maximum: AI_PROVIDER_TEST_RATE_LIMIT.maximum,
    windowMinutes: AI_PROVIDER_TEST_RATE_LIMIT.windowMinutes,
    headers: request.headers,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { message: "اختبارات اتصال كثيرة. أعد المحاولة بعد قليل." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfterSeconds)) } },
    );
  }

  let body: unknown = null;
  try {
    body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    body = {};
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const apiKey = typeof source.apiKey === "string" ? source.apiKey : undefined;

  try {
    const outcome = await testAiProviderConnection(
      id,
      apiKey,
      session.username,
      session.role,
    );
    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: `تعذّر فحص الاتصال: ${(err as Error).message}`, latencyMs: 0 },
      { status: 500 },
    );
  }
}
