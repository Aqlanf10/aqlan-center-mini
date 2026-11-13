import { NextResponse } from "next/server";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { inspectPortalActionToken } from "@/lib/portal-security";
import { FORM_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { consumeSecurityLimit } from "@/lib/security-rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readJsonBody(request, FORM_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const token = typeof (body as Record<string, unknown>)?.token === "string"
    ? ((body as Record<string, unknown>).token as string).trim()
    : "";

  const limit = await consumeSecurityLimit({
    scope: "portal-token-inspect",
    identifier: token.slice(0, 12) || "missing",
    maximum: 15,
    windowMinutes: 15,
    sourceMaximum: 30,
    headers: request.headers,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { message: "محاولات كثيرة للتحقق من الرابط. انتظر قليلًا ثم أعد المحاولة." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfterSeconds)) } },
    );
  }

  try {
    const result = await inspectPortalActionToken(token);
    if (!result.ok) {
      return NextResponse.json({ message: result.message }, { status: result.status });
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ message: "تعذّر التحقق من الرابط الآن." }, { status: 500 });
  }
}
