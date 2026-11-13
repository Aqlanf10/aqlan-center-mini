import { NextResponse } from "next/server";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  PORTAL_ADMIN_PREVIEW_COOKIE,
  PORTAL_COOKIE,
  PORTAL_DURATION_MS,
  createPortalToken,
} from "@/lib/portal";
import { redeemPortalActionToken } from "@/lib/portal-security";
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

  const source = (body ?? {}) as Record<string, unknown>;
  const rawToken = typeof source.token === "string" ? source.token.trim() : "";
  const newPassword = typeof source.password === "string" ? source.password : "";

  const limit = await consumeSecurityLimit({
    scope: "portal-token-redeem",
    identifier: rawToken.slice(0, 12) || "missing",
    maximum: 8,
    windowMinutes: 15,
    sourceMaximum: 20,
    headers: request.headers,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { message: "محاولات كثيرة. أعد المحاولة بعد قليل." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfterSeconds)) } },
    );
  }

  try {
    const result = await redeemPortalActionToken({
      rawToken,
      expectedMode: "activate",
      newPassword,
    });
    if (!result.ok) {
      return NextResponse.json(
        { code: result.code, message: result.message },
        { status: result.status },
      );
    }

    const issuedAt = Date.now();
    const sessionToken = createPortalToken({
      patientId: result.patientId,
      patientNumber: result.patientNumber,
      fullName: result.fullName,
      expiresAt: issuedAt + PORTAL_DURATION_MS,
      credentialVersion: result.credentialVersion,
      issuedAt,
      phoneFingerprint: result.phoneFingerprint,
    });

    const response = NextResponse.json({
      patientNumber: result.patientNumber,
      fullName: result.fullName,
      loginName: result.loginName,
    });
    response.cookies.set(PORTAL_COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(PORTAL_DURATION_MS / 1000),
    });
    response.cookies.set(PORTAL_ADMIN_PREVIEW_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch {
    return NextResponse.json({ message: "تعذّر إتمام تفعيل الحساب الآن." }, { status: 500 });
  }
}
