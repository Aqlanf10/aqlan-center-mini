import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { consumeStaffLoginAttempt, findUserByUsername, recordAudit, updateUser } from "@/lib/db";
import {
  SESSION_COOKIE, SESSION_DURATION_MS, createSessionToken, hashPassword, sessionCredentialVersion, verifyPassword,
} from "@/lib/auth";
import { staffSessionCookieSecure } from "@/lib/sessionCookie";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

/**
 * (P2-2) تغيير كلمة المرور ذاتيًّا — لكل موظفٍ على حسابه هو.
 *
 * كان التغيير للمدير وحده، فالموظف الذي عرف غيرُه كلمته يبقى مكشوفًا حتى يفرغ
 * المدير. الآن: الكلمة الحالية شرط (جلسةٌ مسروقة وحدها لا تكفي لخطف الحساب)،
 * والمحاولات الخاطئة محدودة بعدّادٍ مستقل عن عدّاد الدخول، وتغيير الكلمة يُبطل
 * كل الجلسات الأخرى (نسخة الاعتماد مشتقة من التجزئة) ويُصدر لهذا الجهاز
 * جلسةً جديدة فلا يُطرد من يغيّر كلمته.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const currentPassword = typeof source.currentPassword === "string" ? source.currentPassword : "";
  const newPassword = typeof source.newPassword === "string" ? source.newPassword : "";

  if (!currentPassword) {
    return NextResponse.json({ message: "اكتب كلمة المرور الحالية." }, { status: 400 });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ message: "كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف." }, { status: 400 });
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ message: "كلمة المرور الجديدة أطول من المسموح." }, { status: 400 });
  }
  if (newPassword === currentPassword) {
    return NextResponse.json({ message: "اختر كلمة مرور جديدة تختلف عن الحالية." }, { status: 400 });
  }

  try {
    const limit = await consumeStaffLoginAttempt(
      createHash("sha256").update(`password-change:${session.username.toLowerCase()}`).digest("hex"),
    );
    if (!limit.allowed) {
      return NextResponse.json({ message: "محاولات كثيرة. أعد المحاولة بعد ربع ساعة." }, {
        status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) },
      });
    }

    const user = await findUserByUsername(session.username);
    if (!user || user.id !== session.userId) {
      return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      return NextResponse.json({ message: "كلمة المرور الحالية غير صحيحة." }, { status: 403 });
    }

    const passwordHash = await hashPassword(newPassword);
    const updated = await updateUser(user.id, { passwordHash });
    if (!updated) {
      return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
    }
    await recordAudit({
      action: "user.update", entity: "user", entityId: user.id, entityLabel: user.username,
      details: { التغيير: "غيّر كلمة مروره بنفسه" },
      actor: session.username, actorRole: session.role,
    }).catch(() => {});

    const token = createSessionToken({
      userId: user.id,
      username: user.username,
      role: user.role,
      expiresAt: Date.now() + SESSION_DURATION_MS,
      partyId: user.partyId,
      credentialVersion: sessionCredentialVersion(passwordHash),
    });
    const response = NextResponse.json({ ok: true, message: "تغيّرت كلمة المرور. سُجّل خروج الأجهزة الأخرى." });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: staffSessionCookieSecure(request.headers.get("host")),
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(SESSION_DURATION_MS / 1000),
    });
    return response;
  } catch {
    return NextResponse.json({ message: "تعذّر تغيير كلمة المرور. أعد المحاولة." }, { status: 500 });
  }
}
