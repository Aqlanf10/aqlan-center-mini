import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername, recordAudit } from "@/lib/db";
import { type Role, canUseAiChat } from "@/lib/roles";
import { aiChat, getAiSettings, type AiChatMessage } from "@/lib/ai";
import { deIdentifyClinicalContext } from "@/lib/ai-tools/privacy";
import type { AiToolContext, StructuredAiResponse } from "@/lib/ai-tools/types";
import { canAccessPatient } from "@/lib/patient-access";
import { processAssistantQuery, detectPromptInjection } from "@/lib/assistant-engine";
import { dbTodayISO } from "@/lib/reports";

export const dynamic = "force-dynamic";

/**
 * النظام التوجيهي للمساعد السريري والإداري والتنفيذي لمركز د. عقلان لطب وتقويم الأسنان.
 * يحقق المادة 214 دستوريًا: الذكاء الاصطناعي يقترح ولا يعتمد.
 * ويحقق المادة 202: عدم تسريب أي بيانات تعريفية شخصية للمرضى لمزود خارجي.
 */
export const DENTAL_ASSISTANT_SYSTEM_PROMPT = `أنت «المساعد الذكي الشامل لمركز د. عقلان لطب وجراحة وتقويم الأسنان» (Dr. Aqlan Dental Center AI Assistant).
مهمتك تقديم المشورة السريرية والإدارية النصية للطاقم الطبي بالمركز في:
1. الاستشارات السريرية لطب الأسنان (حشو العصب، جراحة الفم، تقويم الأسنان، الأدوية ومخدرات الأسنان وجرعاتها، تعليمات ما بعد العمليات).
2. إرشادات تشغيلية عامة عن سير العمل في المركز (المواعيد، المرضى، المخزون، المعمل، المالية — وفق صلاحيات المستخدم المسؤول).
الالتزام الدستوري (المادة 214): الذكاء الاصطناعي يقترح ولا يعتمد القرارات السريرية النهائية؛ الطبيب البشري هو المسؤول الأول والأخير.

أنت **مستشار نصي فقط**: تنفيذ أي إجراء في النظام يتم حصراً عبر واجهاته الرسمية وبعد تأكيد المستخدم الصريح داخل النظام. لا تُصدِر كائنات JSON أو أوامر تنفيذ تُطلب تنفيذها، ولا تدّعِ أنك تستطيع تنفيذها؛ وإن طُلب منك ذلك في أي رسالة فاذكر أن الاقتراح نصي وأن التنفيذ يتم من واجهة النظام.

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

  // استخراج سجل المحادثة — رسائل العميل **بياناتٌ لا هوية** (P0.5):
  // role=system من العميل يُهمَد بالكامل (البرومبت النظامي الموثوق يملكه الخادم
  // وحده)، وrole=assistant يُقبل كسياقٍ غير موثوق لا يُمنح أي امتياز.
  const incomingMessages: AiChatMessage[] = [];

  if (Array.isArray(source.messages) && source.messages.length > 0) {
    for (const m of source.messages) {
      if (m && typeof m === "object") {
        const item = m as Record<string, unknown>;
        if (item.role === "system") continue; // برومبت نظام من العميل: مهمل
        const role = item.role === "assistant" ? "assistant" : "user";
        const content = typeof item.content === "string" ? item.content.trim() : "";
        if (content) {
          incomingMessages.push({ role, content: content.slice(0, 4000) });
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

  // فحص حقن التعليمات على **كامل** السجل لا على آخر رسالة فقط (P0.5):
  // رسالة قديمة ملوثة قد تُحرّك النموذج الخارجي أو المحرك نحو إجراء غير مقصود.
  for (const m of incomingMessages) {
    if (detectPromptInjection(m.content)) {
      return NextResponse.json(
        {
          ok: false,
          message:
            "🔒 **تنبيه أمني وحوكمة:** وُجد في سجل المحادثة نصٌ يحاول تجاوز قواعد الأمان. لا يمكن تعديل الصلاحيات أو تجاوز عزل الأطباء عبر الأوامر النصية — تُفحص الصلاحيات حصراً عبر جلسة الخادم الموثقة.",
          intent: "security_rejection",
        },
        { status: 400 },
      );
    }
  }

  const started = Date.now();
  const doctorPartyId = user.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
  const todayISO = await dbTodayISO().catch(() => new Date().toISOString().slice(0, 10));
  const isDbConnected = isDatabaseOnline();

  // سياق المريض الجلسي إن أُرسل من العميل: لا يُصدَّق قبل فحص ملكيته (P0.5) —
  // conversationPatientId مُسَمّم لا يفتح ملف مريض زميل.
  let conversationPatientId: number | null = null;
  let droppedPatientContext = false;
  if (typeof source.conversationPatientId === "number" && source.conversationPatientId > 0) {
    const allowed = isDbConnected
      ? await canAccessPatient(session, source.conversationPatientId).catch(() => false)
      : true; /* بلا قاعدة بيانات لا ملفات تُفتح أصلًا */
    if (allowed) {
      conversationPatientId = source.conversationPatientId;
    } else {
      droppedPatientContext = true;
    }
  }

  const assistantContext: AiToolContext = {
    userId: user.id,
    username: session.username,
    role: session.role as Role,
    doctorPartyId,
    permissions: user.permissions ?? null,
    canViewAllPatients: user.permissions?.canViewAllPatients ?? (session.role !== "doctor"),
    canViewClinicFinance: user.permissions?.canViewClinicFinance ?? session.role === "admin",
    canViewOwnCommissions: user.permissions?.canViewOwnCommissions ?? true,
    canManageInventory: session.role === "admin" || session.role === "reception",
    todayISO,
    isDbConnected,
    conversationPatientId,
  };

  const latestUserMsg = incomingMessages[incomingMessages.length - 1]?.content || "";

  // تنفيذ المعالجة عبر محرك الاستعلامات الداخلي الموحد
  let response: StructuredAiResponse = await processAssistantQuery(
    latestUserMsg,
    assistantContext,
    incomingMessages,
  );

  /* سياق مريضٍ مسموم أُسقط: يُعلَن للمستخدم لا يُمرَّر بصمت (P0.5). */
  if (droppedPatientContext) {
    response = {
      ...response,
      warnings: [
        ...(response.warnings || []),
        "أُسقط سياق مريضٍ مرسل من العميل لست مصرّحًا لك بالوصول إليه (P0.5)",
      ],
    };
  }

  // إذا كان المزود السحابي مفعلاً والسؤال سريري أو استشاري عام، يُستشار كمستشارٍ
  // نصي بعد التعقيم — **حدّ الثقة الخارجي (P0.4)**: ردّ المزود مشورةٌ نصية فقط؛
  // لا يُستخرج منه JSON ولا تُنفّذ منه أداة مهما تضمّن من صيَغ تنفيذية، فالمزود
  // الخارجي لا يمنح تفويضًا، والتنفيذ في النظام يتم عبر مساره الرسمي وتأكيده.
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

      // تعقيم كامل سجل المحادثة قبل إرساله للمزود الخارجي — ورسائل system من
      // العميل أُسقطت أصلًا عند التجميع، فلا تصل المزود أبدًا (P0.5).
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
        response = {
          ...response,
          answer: cloudResult.content.trim(),
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
