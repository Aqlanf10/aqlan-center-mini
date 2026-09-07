import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername, recordAudit } from "@/lib/db";
import { canUseAiChat, type Role } from "@/lib/roles";
import type { AiToolContext } from "@/lib/ai-tools/types";
import { executeAiTool } from "@/lib/ai-tools/registry";
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

async function handleConfirmation(token: string) {
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

  if (!token || typeof token !== "string" || !token.trim()) {
    return NextResponse.json({ message: "رمز التأكيد مفقود أو غير صالح." }, { status: 400 });
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

  const result = await executeAiTool(
    "confirm_ai_action",
    { confirmationToken: token.trim() },
    assistantContext,
  );

  try {
    await recordAudit({
      action: "ai.chat",
      entity: "ai_confirmation",
      entityId: String(user.id),
      entityLabel: `تأكيد إجراء بالذكاء الاصطناعي: ${user.displayName || user.username}`,
      details: {
        success: result.success,
        tokenPrefix: token.trim().slice(0, 16),
        textSummary: result.textSummary,
      },
      actor: session.username,
      actorRole: session.role,
    });
  } catch {}

  return NextResponse.json({
    ok: result.success,
    reply: result.textSummary,
    ...result,
  }, { status: result.success ? 200 : 400 });
}

export async function POST(request: Request) {
  let token = "";
  try {
    const body = (await request.json()) as Record<string, unknown>;
    token = typeof body.confirmationToken === "string" ? body.confirmationToken : (typeof body.token === "string" ? body.token : "");
  } catch {}

  if (!token) {
    const url = new URL(request.url);
    token = url.searchParams.get("token") || "";
  }

  return handleConfirmation(token);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  return handleConfirmation(token);
}
