import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername, recordAudit } from "@/lib/db";
import { type Role, canUseAiChat } from "@/lib/roles";
import { verifyToolConfirmation } from "@/lib/ai-confirmation";
import { executeAiTool } from "@/lib/ai-tools/registry";
import { resolveToolPolicy } from "@/lib/ai-tools/policy";
import type { AiToolContext } from "@/lib/ai-tools/types";
import { dbTodayISO } from "@/lib/reports";

export const dynamic = "force-dynamic";

/**
 * مسار تنفيذ تأكيد أدوات المساعد الذكي (POST فقط — الرمز لا يمرّ في روابط URL).
 *
 * التدفق الدستوري (P0.6): عرضٌ موقّع → موافقة صريحة → **إعادة تحميل المستخدم
 * من قاعدة البيانات** → إعادة فحص الصلاحيات والدور → إعادة فحص ملكية
 * المريض/المورد من بيانات اللحظة → استهلاكٌ ذرّيّ مرةً واحدة → تنفيذ → تدقيق.
 *
 * لا يمرّ الرمز في query string ولا في logs، والحمولة الموقّعة وحدها مصدر
 * المعاملات — فما وافق عليه المستخدم في المعاينة هو ما يُنفَّذ حرفيًّا.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const token = body.token;
  if (typeof token !== "string" || token.length === 0) {
    return NextResponse.json({ message: "رمز التأكيد مفقود." }, { status: 400 });
  }

  const payload = verifyToolConfirmation(token);
  if (!payload) {
    return NextResponse.json(
      { message: "رمز التأكيد غير صالح أو انتهت صلاحيته (عشر دقائق). أعد الطلب من المحادثة." },
      { status: 400 },
    );
  }

  /* الأداة لا بد أن تكون مسجلة في السياسة المركزية — المجهول مرفوض هنا أيضًا. */
  const policy = resolveToolPolicy(payload.tool);
  if (!policy || !policy.requiresConfirmation) {
    return NextResponse.json(
      { message: "الرمز لا يخص أداة تغيير حالة معتمدة." },
      { status: 400 },
    );
  }

  /* إعادة تحميل المستخدم من قاعدة البيانات: الرمز صالح، لكن الحساب نفسه قد
     عُطّل أو سُحبت صلاحيته أو تغيّر دوره منذ العرض — كل ذلك يُفحص الآن. */
  const user = await findUserByUsername(session.username);
  if (!user || !user.isActive) {
    return NextResponse.json({ message: "حساب المستخدم غير نشط أو غير موجود." }, { status: 403 });
  }
  if (payload.userId !== user.id) {
    return NextResponse.json(
      { message: "رمز التأكيد صادر لمستخدم آخر — لا يُنفَّذ نيابةً عنه." },
      { status: 403 },
    );
  }
  if (!canUseAiChat(session.role, user.permissions)) {
    return NextResponse.json(
      { message: "ليس لديك صلاحية تنفيذ إجراءات المساعد الذكي." },
      { status: 403 },
    );
  }

  const todayISO = await dbTodayISO().catch(() => new Date().toISOString().slice(0, 10));
  const databaseUrl = (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    ""
  ).toLowerCase();
  const isCiPlaceholder =
    databaseUrl.includes("ci:ci@") ||
    databaseUrl.includes("127.0.0.1:5432/aqlan_center_ci") ||
    databaseUrl.includes("ci-placeholder");
  const isDbConnected = !isCiPlaceholder && Boolean(databaseUrl || process.env.USE_LOCAL_DB === "true");

  const doctorPartyId = user.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);

  const context: AiToolContext = {
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
    confirmationExecution: payload,
  };

  const started = Date.now();
  let result;
  try {
    result = await executeAiTool(policy.canonicalName, payload.params as Record<string, any>, context);
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء المؤكد." }, { status: 500 });
  }

  /* تدقيق التنفيذ المؤكد: من، أي أداة، أي مريض، ورمزٌ يعرّف الطلب الواحد. */
  try {
    await recordAudit({
      action: "ai.confirmation.execute",
      entity: "ai_confirmation",
      entityId: payload.jti,
      entityLabel: `${policy.canonicalName} — ${user.displayName || user.username}`,
      details: {
        tool: policy.canonicalName,
        userId: user.id,
        patientId: payload.patientId ?? null,
        executed: result.success,
        latencyMs: Date.now() - started,
      },
      actor: session.username,
      actorRole: session.role,
    });
  } catch {
    /* فشل التدقيق لا يعطل تنفيذًا تمّ توثيقه داخل الأداة نفسها أيضًا. */
  }

  return NextResponse.json({
    ok: result.success,
    reply: result.textSummary,
    ...result,
  });
}
