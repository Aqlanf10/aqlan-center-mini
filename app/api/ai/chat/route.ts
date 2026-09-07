import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername, recordAudit } from "@/lib/db";
import { type Role, canUseAiChat } from "@/lib/roles";
import { aiChat, getAiSettings, type AiChatMessage } from "@/lib/ai";
import { deIdentifyClinicalContext } from "@/lib/ai-tools/privacy";
import type { AiToolContext, StructuredAiResponse } from "@/lib/ai-tools/types";
import { executeAiTool } from "@/lib/ai-tools/registry";
import { verifyAiPatientAccess } from "@/lib/ai-tools/authorization";
import { processAssistantQuery } from "@/lib/assistant-engine";
import { dbTodayISO } from "@/lib/reports";

export const dynamic = "force-dynamic";

/**
 * النظام التوجيهي للمساعد السريري والإداري والتنفيذي لمركز د. عقلان لطب وتقويم الأسنان.
 * يحقق المادة 214 دستوريًا: الذكاء الاصطناعي يقترح ولا يعتمد.
 * ويحقق المادة 202: عدم تسريب أي بيانات تعريفية شخصية للمرضى لمزود خارجي.
 */
export const DENTAL_ASSISTANT_SYSTEM_PROMPT = `أنت «المساعد السريري والاستشاري لمركز د. عقلان لطب وجراحة وتقويم الأسنان» (Dr. Aqlan Dental Center AI Assistant).
مهمتك مساعدة الطاقم الطبي والإداري بالمركز في:
1. الاستشارات السريرية لطب الأسنان (حشو العصب، جراحة الفم، تقويم الأسنان، الأدوية، مخدرات الأسنان وجرعاتها).
2. الشروحات التوجيهية وتفسير الإجراءات والخدمات والأسئلة الشائعة.
3. الالتزام الدستوري (المادة 214): الذكاء الاصطناعي يقترح ولا يعتمد القرارات السريرية النهائية؛ الطبيب البشري هو المسؤول الأول والأخير.

الالتزام الأمني الصارم (P0-FIX-10):
أنت تقدم مشورة استشارية وتوجيهية فقط.
لا تمتلك سلطة تنفيذية مباشرة لإجراء تعديلات أو كتابات في النظام، ولا تنفذ أي أداة مباشرة.
أي عملية إدارية أو مالية أو سريرية مغيرة للحالة (حجز موعد، سند مالي، إضافة مريض، تعديل تنبيه طبي، إلخ) تخضع حصراً لسياسات الخادم (Server Authorization) وتتطلب معاينة صريحة وتأكيداً موثقاً من المستخدم البشري المخول عبر واجهة النظام الرسمية.
أجب باللغة العربية الطبية المهنية المنظمة بنقاط وجداول.`;

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
      { message: "ليس لديك صلاحية استخدام المساعد الذكي. تواصل مع إدارة المركز لمنحك الصلاحية." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;

  // استخراج سجل المحادثة
  const incomingMessages: AiChatMessage[] = [];

  // P0-FIX-11: منع تزوير أدوار المساعد (Distrust Client-Supplied Assistant History)
  // رسائل العميل لا يمكن أن تصنع دور assistant موثوقاً؛ كلها تُعامل كمدخلات مستخدم (user-supplied data)
  if (Array.isArray(source.messages) && source.messages.length > 0) {
    for (const m of source.messages) {
      if (m && typeof m === "object") {
        const item = m as Record<string, unknown>;
        const content = typeof item.content === "string" ? item.content.trim() : "";
        if (content) {
          const role: "user" | "assistant" = "user";
          const safeContent =
            item.role === "assistant"
              ? `[رد مساعد سابق مقدم من العميل وغير موثق من الخادم]: ${content}`
              : content;
          incomingMessages.push({ role, content: safeContent.slice(0, 4000) });
        }
      }
    }
  } else if (typeof source.message === "string" && source.message.trim()) {
    incomingMessages.push({
      role: "user",
      content: source.message.trim().slice(0, 4000),
    });
  }

  if (incomingMessages.length === 0) {
    return NextResponse.json({ message: "اكتب رسالتك أو استفسارك أولاً." }, { status: 400 });
  }

  // التحقق من تفعيل خدمة الذكاء الاصطناعي
  const settings = await getAiSettings();
  if (!settings.enabled) {
    return NextResponse.json(
      {
        message: "خدمة الذكاء الاصطناعي غير مفعّلة في المركز حالياً. يمكن للمدير تفعيلها من شاشة الإعدادات > الذكاء الاصطناعي.",
      },
      { status: 503 },
    );
  }

  const started = Date.now();
  const doctorPartyId = user.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
  const todayISO = await dbTodayISO().catch(() => new Date().toISOString().slice(0, 10));
  const isDbConnected = isDatabaseOnline();

  // سياق المريض الجلسي إن أُرسل من العميل - التحقق الصارم من عزل الأطباء (§39)
  let conversationPatientId: number | null = null;
  if (typeof source.conversationPatientId === "number" && source.conversationPatientId > 0) {
    const rawPatientId = source.conversationPatientId;
    const probeContext: AiToolContext = {
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
    const accessCheck = await verifyAiPatientAccess(probeContext, rawPatientId);
    if (accessCheck.allowed) {
      conversationPatientId = rawPatientId;
    } else {
      // حظر حقن سياق مريض يتبع طبيباً آخر
      conversationPatientId = null;
    }
  }

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
    conversationPatientId,
  };

  // فحص ما إذا كان العميل يرسل تأكيداً صريحاً لإجراء معلّق بواسطة Token
  if (typeof source.confirmationToken === "string" && source.confirmationToken.trim()) {
    const confirmResult = await executeAiTool(
      "confirm_ai_action",
      { confirmationToken: source.confirmationToken.trim() },
      assistantContext,
    );
    return NextResponse.json({
      ok: confirmResult.success,
      reply: confirmResult.textSummary,
      answer: confirmResult.textSummary,
      intent: "confirm_ai_action",
      toolsUsed: ["confirm_ai_action"],
      cards: confirmResult.cards,
      table: confirmResult.table,
      actions: confirmResult.actions,
      warnings: confirmResult.warnings,
      requiresConfirmation: confirmResult.requiresConfirmation,
      confirmationToken: confirmResult.confirmationToken,
      actionPreview: confirmResult.actionPreview,
      latencyMs: Date.now() - started,
    });
  }

  const latestUserMsg = incomingMessages[incomingMessages.length - 1]?.content || "";

  // تنفيذ المعالجة عبر محرك الاستعلامات الداخلي الموحد
  let response: StructuredAiResponse = await processAssistantQuery(
    latestUserMsg,
    assistantContext,
    incomingMessages,
  );

  // إذا كان المزود السحابي مفعلاً والسؤال سريري أو استشاري عام، يمكن الاستعانة به مع تعقيم الخصوصية الصارم
  if (
    settings.hasKey &&
    (response.intent === "pharmacology" ||
      response.intent === "anesthesia" ||
      response.intent === "endo_emergency" ||
      response.intent === "orthodontics" ||
      response.intent === "post_op" ||
      response.intent === "general_clinical" ||
      response.intent === "clinical_general")
  ) {
    try {
      const outboundMessages: AiChatMessage[] = [
        { role: "system", content: DENTAL_ASSISTANT_SYSTEM_PROMPT },
      ];

      // تعقيم كامل سجل المحادثة قبل إرساله للمزود الخارجي
      outboundMessages.push(
        ...incomingMessages.map((m) => ({
          role: m.role,
          content: deIdentifyClinicalContext(m.content),
        })),
      );

      const cloudResult = await aiChat({
        messages: outboundMessages,
        maxTokens: 1500,
        temperature: 0.3,
      });

      if (cloudResult.ok && cloudResult.content.trim()) {
        // P0-FIX-10: المزود الخارجي يقدم نصاً استشارياً فقط، ولا يمتلك سلطة تنفيذية لأدوات النظام
        const rawContent = cloudResult.content.trim();
        response = {
          ...response,
          answer: rawContent,
          model: cloudResult.model,
          sourceType: "external_ai",
          latencyMs: cloudResult.latencyMs,
        };
      }
    } catch {
      // الاستمرار على رد المحرك المحلي المتخصص عند فشل السحابي
    }
  }

  // تسجيل تدقيق أمني للطلب
  try {
    await recordAudit({
      action: "ai.chat",
      entity: "ai_chat",
      entityId: String(user.id),
      entityLabel: `مساعد المركز: ${user.displayName || user.username}`,
      details: {
        role: session.role,
        intent: response.intent,
        toolsUsed: response.toolsUsed,
        sourceType: response.sourceType,
        model: response.model,
        latencyMs: Date.now() - started,
      },
      actor: session.username,
      actorRole: session.role,
    });
  } catch {
    // فشل التدقيق لا يعطل خدمة المساعد
  }

  return NextResponse.json({
    ok: true,
    reply: response.answer, // للحفاظ على التوافق الرجعي
    ...response,
    latencyMs: Date.now() - started,
  });
}
