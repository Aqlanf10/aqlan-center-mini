import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { consumeStaffLoginAttempt, findUserByUsername } from "@/lib/db";
import { consumeLoginAttemptFor } from "@/lib/loginLimit";
import { firstHeaderEntry, isHostTrusted } from "@/lib/net";
import {
  readBoundedFormData,
  readJsonBody,
  bodyErrorResponse,
} from "@/lib/http-body";
import { FORM_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import {
  SESSION_COOKIE,
  SESSION_DURATION_MS,
  createSessionToken,
  verifyPassword,
  sessionCredentialVersion,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

function getRedirectUrl(path: string, request: Request): string {
  /* (P0.15) ترويسات المضيف يكتبها العميل: لا يُبنى منها رابطٌ مطلق إلا إن
   * طابق قائمة النطاقات التي يملكها المشغّل (TRUSTED_HOSTS) — وما عدا ذلك
   * مسارٌ نسبي يحلّه المتصفّح على أصل الطلب نفسه. فبلا القائمة يبقى تصيّد
   * «redirect إلى نطاق المهاجم بعد تسجيل دخولٍ ناجح» بابًا موصدًا. */
  const forwardedHost = firstHeaderEntry(request.headers.get("x-forwarded-host"))
    ?? firstHeaderEntry(request.headers.get("host"));
  const rawProto = firstHeaderEntry(request.headers.get("x-forwarded-proto")) ?? "https";
  const proto = rawProto === "http" ? "http" : "https";
  if (forwardedHost && isHostTrusted(forwardedHost)) {
    return `${proto}://${forwardedHost}${path}`;
  }
  /* المسار النسبي يرفضه NextResponse.redirect (يطلب مطلقًا)، فالمصدر الآمن
   * هو أصل الطلب نفسه كما رآه الخادم (request.url) — لا ترويسات العميل فيه. */
  return new URL(path, request.url).toString();
}

export async function POST(request: Request) {
  let username = "";
  let password = "";
  const contentType = request.headers.get("content-type") || "";
  const acceptHeader = request.headers.get("accept") || "";
  const isHtmlRequest = acceptHeader.includes("text/html") || contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");

  try {
    /* (P2/S8) جسم محدود مهما كان نوعه: JSON أو نموذج HTML — القارئ المحدود
       يرد 413 قبل التحليل مهما بلغ الحجم المعلن أو غير المعلن. */
    if (contentType.includes("application/json")) {
      const body = await readJsonBody<Record<string, unknown>>(request, FORM_BODY_LIMIT_BYTES);
      if (body && typeof body === "object") {
        username = typeof body.username === "string" ? body.username.trim() : "";
        password = typeof body.password === "string" ? body.password : "";
      }
    } else {
      const formData = await readBoundedFormData(request, FORM_BODY_LIMIT_BYTES);
      username = (formData.get("username") as string)?.trim() || "";
      password = (formData.get("password") as string) || "";
    }
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
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
    /* الحدّ الجديد (من مستودع الوكيل الآخر): مفتاح HMAC لل حساب — يعمل بين النسخ
       ومع إعادة التشغيل — وحدُّ المصدر خلف وسيطٍ موثّق فقط. والحدّ القديم
       يبقى تحته: من تجاوز واحدين لا يعبر. */
    const sharedLimit = await consumeLoginAttemptFor("staff", username, request.headers);
    if (!sharedLimit.allowed) {
      return NextResponse.json({ message: "محاولات دخول كثيرة. أعد المحاولة بعد ربع ساعة." }, {
        status: 429, headers: { "Retry-After": String(sharedLimit.retryAfterSeconds) },
      });
    }
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

    /* (P2/S4) قرار SameSite=Lax في الإنتاج: الكوكي ترسل مع التنقل من نفس
     * الموقع فقط لا مع الطلبات الفرعية العابرة للمواقع — فيغلق باب CSRF من
     * جذر الشجرة نفسه. لا حاجة إنتاجية مثبتة اليوم لـNone: فحص الكود لم
     * يجد iframe خارجيًّا يضمّن لوحة الطاقم، والمعاينة الوحيدة (PDF المستندات)
     * iframe من نفس الأصل — يعمل مع Lax تمامًا. Partitioned أُزيل معه: كان
     * لازمًا لNone عبر السياقات المقسّمة، وبلا None لا معنى له.
     * المحلي يبقى lax دائمًا وSecure=false فوق HTTP. */
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,      // لا تستطيع أي نصوص في الصفحة قراءتها
      secure: !isLocal,    // تُرسل عبر HTTPS في الإنتاج
      sameSite: "lax",     // (P2/S4) — لا None ولا Partitioned في الإنتاج
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
