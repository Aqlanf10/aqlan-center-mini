import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername, recordAudit } from "@/lib/db";
import { canUseAiChat, type Role } from "@/lib/roles";
import type { AiToolContext } from "@/lib/ai-tools/types";
import { executeConfirmedAiAction } from "@/lib/ai-tools/confirmed-action";
import { dbTodayISO } from "@/lib/reports";

export const dynamic = "force-dynamic";

function isDatabaseOnline(): boolean {
  const url = (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    ""
  ).toLowerCase();

  if (
    url.includes("127.0.0.1:5432/aqlan_center_ci") ||
    url.includes("ci:ci@") ||
    url.includes("ci-placeholder") ||
    url.includes("ep-ci-placeholder") ||
    (process.env.CI === "true" && url.includes("127.0.0.1"))
  ) {
    return false;
  }

  return Boolean(url || process.env.USE_LOCAL_DB === "true");
}

/**
 * P0-FIX-3: منع أي عملية تغيير حالة عبر GET
 * حماية مطلقة ضد Pre-fetching و Link Scanners و Browser History والتصفح العرضي
 */
export async function GET() {
  return NextResponse.json(
    {
      error: "Method Not Allowed",
      message: "تأكيد وتنفيذ العمليات المغيرة للحالة مقتصر حصراً على طلبات POST ذات المحتوى المشفر (JSON Body Only).",
    },
    {
      status: 405,
      headers: {
        Allow: "POST",
      },
    },
  );
}

/**
 * P0-FIX-2 & P0-FIX-3: مسار التأكيد الرسمي والوحيد (POST JSON Only)
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  const user = await findUserByUsername(session.username);
  if (!user || !user.isActive) {
    return NextResponse.json({ message: "حساب المستخدم غير نشط أو غير موجود." }, { status: 403 });
  }

  const hasPermission = canUseAiChat(session.role, user.permissions);
  if (!hasPermission) {
    return NextResponse.json(
      { message: "ليس لديك صلاحية استخدام المساعد الذكي أو تأكيد العمليات." },
      { status: 403 },
    );
  }

  // P0-FIX-3: استخراج التوكن من JSON Body فقط، ورفض Query String تماماً
  let token = "";
  let overrideParams: Record<string, any> | undefined;

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json(
        { message: "نوع الطلب غير صالح. يجب إرسال رأس Content-Type: application/json." },
        { status: 415 },
      );
    }
    const body = (await request.json()) as Record<string, unknown>;
    token =
      typeof body.confirmationToken === "string"
        ? body.confirmationToken.trim()
        : typeof body.token === "string"
          ? body.token.trim()
          : "";
    if (body.overrideParams && typeof body.overrideParams === "object" && !Array.isArray(body.overrideParams)) {
      overrideParams = body.overrideParams as Record<string, any>;
    }
  } catch {
    return NextResponse.json({ message: "محتوى الطلب (JSON Body) غير صالح." }, { status: 400 });
  }

  if (!token) {
    return NextResponse.json(
      { message: "رمز التأكيد (confirmationToken) مفقود في جسم الطلب (JSON Body)." },
      { status: 400 },
    );
  }

  const doctorPartyId = user.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
  const todayISO = await dbTodayISO().catch(() => new Date().toISOString().slice(0, 10));
  const isDbConnected = isDatabaseOnline();

  const assistantContext: AiToolContext = {
    userId: user.id,
    username: session.username,
    role: session.role as Role,
    doctorPartyId,
    permissions: user.permissions ?? null,
    canViewAllPatients: user.permissions?.canViewAllPatients ?? (session.role !== "doctor"),
    canViewClinicFinance: user.permissions?.canViewClinicFinance ?? (session.role === "admin" || session.role === "accountant"),
    canViewOwnCommissions: user.permissions?.canViewOwnCommissions ?? true,
    canManageInventory: session.role === "admin" || session.role === "reception",
    todayISO,
    isDbConnected,
  };

  // P0-FIX-2: استدعاء الخدمة الموحدة مباشرة
  const result = await executeConfirmedAiAction(token, assistantContext, overrideParams);

  try {
    await recordAudit({
      action: "ai.chat",
      entity: "ai_confirmation",
      entityId: String(user.id),
      entityLabel: `تأكيد إجراء بالذكاء الاصطناعي: ${user.displayName || user.username}`,
      details: {
        success: result.success,
        tokenPrefix: token.slice(0, 16),
        textSummary: result.textSummary,
      },
      actor: session.username,
      actorRole: session.role,
    });
  } catch {}

  return NextResponse.json(
    {
      ok: result.success,
      reply: result.textSummary,
      ...result,
    },
    { status: result.success ? 200 : 400 },
  );
}
