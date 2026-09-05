import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { consumeStaffLoginAttempt, findUserByUsername } from "@/lib/db";
import {
  SESSION_COOKIE,
  SESSION_DURATION_MS,
  createSessionToken,
  verifyPassword,
  sessionCredentialVersion,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

function getRedirectUrl(path: string, request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost && !forwardedHost.includes("0.0.0.0") && !forwardedHost.includes("127.0.0.1")) {
    return `${forwardedProto}://${forwardedHost}${path}`;
  }
  return path;
}

export async function POST(request: Request) {
  let username = "";
  let password = "";
  const contentType = request.headers.get("content-type") || "";
  const acceptHeader = request.headers.get("accept") || "";
  const isHtmlRequest = acceptHeader.includes("text/html") || contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");

  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      if (body && typeof body === "object") {
        username = typeof body.username === "string" ? body.username.trim() : "";
        password = typeof body.password === "string" ? body.password : "";
      }
    } else {
      const formData = await request.formData();
      username = (formData.get("username") as string)?.trim() || "";
      password = (formData.get("password") as string) || "";
    }
  } catch {
    if (isHtmlRequest) {
      return NextResponse.redirect(getRedirectUrl("/login?error=invalid_request", request), 303);
    }
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  if (!username || !password) {
    if (isHtmlRequest) {
      return NextResponse.redirect(getRedirectUrl("/login?error=missing_fields", request), 303);
    }
    return NextResponse.json({ message: "اسم المستخدم وكلمة المرور مطلوبان." }, { status: 400 });
  }

  try {
    const limit = await consumeStaffLoginAttempt(createHash("sha256").update(username.toLowerCase()).digest("hex"));
    if (!limit.allowed) {
      return NextResponse.json({ message: "محاولات دخول كثيرة. أعد المحاولة بعد ربع ساعة." }, {
        status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) },
      });
    }
    const user = await findUserByUsername(username);
    if (!user) {
      await verifyPassword(password, "scrypt:0000:0000");
      if (isHtmlRequest) {
        return NextResponse.redirect(getRedirectUrl("/login?error=invalid_credentials", request), 303);
      }
      return NextResponse.json(
        { message: "اسم المستخدم أو كلمة المرور غير صحيحة." },
        { status: 401 },
      );
    }

    const isStandardMatch = await verifyPassword(password, user.passwordHash);

    if (!isStandardMatch) {
      if (isHtmlRequest) {
        return NextResponse.redirect(getRedirectUrl("/login?error=invalid_credentials", request), 303);
      }
      return NextResponse.json(
        { message: "اسم المستخدم أو كلمة المرور غير صحيحة." },
        { status: 401 },
      );
    }

    const expiresAt = Date.now() + SESSION_DURATION_MS;
    const token = createSessionToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      expiresAt,
      // جهة الطبيب المرتبطة (§٣٥): بها يعرف الخادم مرضى هذا الحساب فيحجب ما ليس لهم.
      partyId: user.partyId,
      credentialVersion: sessionCredentialVersion(user.passwordHash),
    });

    const response = isHtmlRequest
      ? NextResponse.redirect(getRedirectUrl("/", request), 303)
      : NextResponse.json({
          token,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
        });

    const forwardedProto = request.headers.get("x-forwarded-proto");
    const host = request.headers.get("host") || "";
    const isLocal = host.includes("localhost") || host.includes("127.0.0.1") || forwardedProto === "http";

    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,      // لا تستطيع أي نصوص في الصفحة قراءتها
      secure: !isLocal,    // تُرسل عبر HTTPS في الإنتاج
      sameSite: isLocal ? "lax" : "none",    // lax للمحلي و none للمحاكي/iframe
      partitioned: !isLocal,
      path: "/",
      maxAge: Math.floor(SESSION_DURATION_MS / 1000),
    });
    return response;
  } catch (error) {
    const missingSecret = error instanceof Error && error.message.includes("SESSION_SECRET");
    if (isHtmlRequest) {
      return NextResponse.redirect(new URL("/login?error=server_error", request.url), 303);
    }
    return NextResponse.json(
      {
        message: missingSecret
          ? "الأداة غير مكتملة الإعداد: SESSION_SECRET ناقص في إعدادات النشر."
          : "تعذّر تسجيل الدخول. أعد المحاولة.",
      },
      { status: missingSecret ? 503 : 500 },
    );
  }
}
