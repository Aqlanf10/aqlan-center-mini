import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername, personNameTokens, recordAudit } from "@/lib/db";
import { type Role, canUseAiChat } from "@/lib/roles";
import { readAssistantControlSettings } from "@/lib/assistant-mode-settings";
import { assistantModes, EXTERNAL_ADMIN_TEMPLATES, externalOnlyTemplate, greetingReply } from "@/lib/assistant-modes";
import { clinicalCapabilityOf } from "@/lib/clinical-identity";
import { aiChat, getAiSettings, type AiChatMessage } from "@/lib/ai";
import { deIdentifyClinicalContext } from "@/lib/ai-tools/privacy";
import { ADMIN_ASSISTANT_SYSTEM_PROMPT, CLINICAL_SCOPE_NOTICE, externalConsultPlan, redactPersonNames } from "@/lib/ai-scope";
import type { AiToolContext, StructuredAiResponse } from "@/lib/ai-tools/types";
import { canAccessPatient } from "@/lib/patient-access";
import { processAssistantQuery, detectPromptInjection } from "@/lib/assistant-engine";
import { dbTodayISO } from "@/lib/reports";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { AI_CHAT_BODY_LIMIT_BYTES, AI_CHAT_RATE_LIMIT } from "@/lib/security-limits";
import { consumeSecurityLimit } from "@/lib/security-rate-limit";

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
  const response = await handlePost(request);
  // Denials and bounded-body/rate-limit errors must also be non-cacheable.
  // Preserve the response status and any existing headers (e.g. Retry-After).
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function handlePost(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  let user: Awaited<ReturnType<typeof findUserByUsername>>;
  try {
    user = await findUserByUsername(session.username);
  } catch {
    return NextResponse.json({ message: "تعذّر التحقق من حساب المستخدم. أعد المحاولة لاحقًا." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!user || !user.isActive) {
    return NextResponse.json({ message: "حساب المستخدم غير نشط أو غير موجود." }, { status: 403 });
  }
  // The account can change between requireSession and this second read. Never
  // combine a different account or role with the already admitted session.
  if (user.id !== session.userId || user.role !== session.role) {
    return NextResponse.json({ message: "تغيّرت بيانات الحساب. سجّل الدخول من جديد." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const hasPermission = canUseAiChat(session.role, user.permissions);
  if (!hasPermission) {
    return NextResponse.json(
      { message: "ليس لديك صلاحية استخدام المساعد الذكي. تواصل مع إدارة المركز لمنحك الصلاحية." },
      { status: 403 },
    );
  }

  /* (P2/S10) حدّ معدل موزّع لكل مستخدم — نداء AI مكلف ماليًا وتشغيلياً:
     بصمة HMAC للمستخدم على قاعدة البيانات (بين النسخ ومع إعادة التشغيل). */
  const limit = await consumeSecurityLimit({
    scope: "ai-chat",
    failClosed: true,
    identifier: String(user.id),
    maximum: AI_CHAT_RATE_LIMIT.maximum,
    windowMinutes: AI_CHAT_RATE_LIMIT.windowMinutes,
    headers: request.headers,
  }).catch(() => null);
  if (!limit) {
    return NextResponse.json(
      { message: "تعذّر التحقق من حدّ طلبات المساعد. أعد المحاولة لاحقًا." },
      { status: 503 },
    );
  }
  if (!limit.allowed) {
    return NextResponse.json(
      { message: "طلبات كثيرة على المساعد الذكي. أعد المحاولة بعد قليل." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfterSeconds)) } },
    );
  }

  let body: unknown;
  try {
    /* (P2/S8) جسم المحادثة محدود بحده الموثق — تاريخ حوار غير محدود باب
       DoS وتكلفة، فيُقطع قبل التحليل مهما أُعلن أو لم يُعلن حجمه. */
    body = await readJsonBody(request, AI_CHAT_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  // Match the confirmation endpoint: only a JSON object is a valid chat envelope.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const source = body as Record<string, unknown>;

  // A supplied but malformed patient context must not become an unlinked cloud request.
  // Null/omitted is the explicit no-patient case; all other IDs must be safe positive integers.
  const requestedPatientId = source.conversationPatientId;
  if (requestedPatientId != null && (typeof requestedPatientId !== "number"
    || !Number.isSafeInteger(requestedPatientId) || requestedPatientId <= 0)) {
    return NextResponse.json({ message: "رقم سياق المريض غير صالح." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  // استخراج سجل المحادثة — رسائل العميل **بياناتٌ لا هوية** (P0.5):
  // role=system من العميل يُهمَد بالكامل (البرومبت النظامي الموثوق يملكه الخادم
  // وحده)، وrole=assistant يُقبل كسياقٍ غير موثوق لا يُمنح أي امتياز.
  const incomingMessages: AiChatMessage[] = [];

  if (source.messages != null && !Array.isArray(source.messages)) {
    return NextResponse.json({ message: "سجل المحادثة غير صالح." }, { status: 400 });
  }
  if (Array.isArray(source.messages) && source.messages.length > 0) {
    for (const m of source.messages) {
      // Never silently discard a malformed turn and replay an earlier user request.
      if (!m || typeof m !== "object" || Array.isArray(m)) {
        return NextResponse.json({ message: "رسالة المحادثة غير صالحة." }, { status: 400 });
      }
      const item = m as Record<string, unknown>;
      if (item.role === "system") continue; // برومبت نظام من العميل: مهمل
      if (item.role !== "user" && item.role !== "assistant") {
        return NextResponse.json({ message: "دور رسالة المحادثة غير صالح." }, { status: 400 });
      }
      if (typeof item.content !== "string" || !item.content.trim()) {
        return NextResponse.json({ message: "محتوى رسالة المحادثة غير صالح." }, { status: 400 });
      }
      incomingMessages.push({ role: item.role, content: item.content.trim().slice(0, 4000) });
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
  const settings = await getAiSettings().catch(() => null);
  if (!settings) {
    return NextResponse.json({ message: "تعذّر التحقق من إعدادات خدمة الذكاء الاصطناعي. أعد المحاولة لاحقًا." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
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
  const controlSettings = await readAssistantControlSettings().catch(() => null);
  if (!controlSettings) {
    return NextResponse.json({ message: "تعذّر التحقق من إعدادات المساعد. أعد المحاولة لاحقًا." }, { status: 503 });
  }
  const modes = assistantModes(controlSettings);
  if (!modes.internal && !modes.external) {
    return NextResponse.json({ message: "المساعد الداخلي والخارجي متوقفان من الإعدادات." }, { status: 503 });
  }
  const last = incomingMessages[incomingMessages.length - 1];
  if (last.role !== "user") {
    return NextResponse.json({ message: "اكتب رسالتك أو استفسارك أولاً." }, { status: 400 });
  }
  function simpleReply(answer: string, intent: string, model: string, sourceType: StructuredAiResponse["sourceType"]) {
    return { answer, intent, model, sourceType, toolsUsed: [], generatedAt: new Date().toISOString(), latencyMs: Date.now() - started } satisfies StructuredAiResponse;
  }

  const greeting = greetingReply(last.content);
  if (greeting) {
    return replyWithAudit(simpleReply(greeting, "greeting", "aqlan-assistant-interface", "internal_engine"), started, user, session);
  }
  if (!modes.internal) {
    const template = externalOnlyTemplate(last.content);
    if (!template || source.conversationPatientId != null) {
      const message = "المساعد الداخلي متوقف. فتح الملفات والحجز وحسابات المرضى تبقى داخل البرنامج. للتجربة مع المساعد الخارجي اختر طلبًا عامًا: " + EXTERNAL_ADMIN_TEMPLATES.join("، أو ") + ".";
      return replyWithAudit(simpleReply(message, "internal_assistant_disabled", "aqlan-assistant-interface", "internal_engine"), started, user, session);
    }
    if (!settings.hasKey) {
      return NextResponse.json({ message: "لا يوجد مزوّد خارجي مفعّل بمفتاح محفوظ." }, { status: 503 });
    }
    const external = await aiChat({
      messages: [
        { role: "system", content: ADMIN_ASSISTANT_SYSTEM_PROMPT },
        { role: "user", content: template },
      ],
      maxTokens: 300,
      temperature: 0.3,
    }).catch(() => null);
    if (!external?.ok || !external.content.trim()) {
      return NextResponse.json({ message: "تعذّر الاتصال بالمساعد الخارجي. الداخلي متوقف، ولم يُشغَّل بدلًا منه." }, { status: 503 });
    }
    return replyWithAudit(simpleReply(external.content.trim(), "administrative_template", external.model, "external_ai"), started, user, session);
  }
  // The freshly loaded account is authoritative; an unlinked doctor must not inherit a stale session party.
  const doctorPartyId = user.partyId ?? null;
  const todayISO = await dbTodayISO().catch(() => new Date().toISOString().slice(0, 10));
  const isDbConnected = isDatabaseOnline();

  // سياق المريض الجلسي إن أُرسل من العميل: لا يُصدَّق قبل فحص ملكيته (P0.5) —
  // conversationPatientId مُسَمّم لا يفتح ملف مريض زميل.
  let conversationPatientId: number | null = null;
  let droppedPatientContext = false;
  if (typeof source.conversationPatientId === "number" && source.conversationPatientId > 0) {
    const allowed = isDbConnected
      ? await canAccessPatient({ ...session, partyId: doctorPartyId }, source.conversationPatientId).catch(() => false)
      : false; /* لا يُعتمد سياق مريض بلا تحقق من قاعدة البيانات */
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

  const latestUserMsg = last.content;

  // تنفيذ المعالجة عبر محرك الاستعلامات الداخلي الموحد
  let response: StructuredAiResponse;
  try {
    response = await processAssistantQuery(
      latestUserMsg,
      assistantContext,
      incomingMessages,
    );
  } catch {
    // Without a trusted local result, we cannot classify the request for cloud egress.
    return NextResponse.json(
      { message: "تعذّرت معالجة الطلب داخل المركز. أعد المحاولة لاحقًا." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

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

  /* (P2-11 — قرار المالك) المزوّد الخارجي: Claude للمهام الإدارية فقط.
     القرار كله في externalConsultPlan (lib/ai-scope):
     - إداري (تشغيل العيادة): رسالة المستخدم الأخيرة وحدها بعد إزالة الهوية — لا سجلّ قد
       يحمل نصًّا سريريًّا سابقًا، ولا بيانات من قاعدة المركز.
     - سريري: لا يخرج إلا بتفعيل `ai.clinical_external` صراحةً، ولحامل هويةٍ سريرية
       ثابتة (مراجعة P0) — وإلا فالرد من المحرك المحلي مع تنبيهٍ لا يمر صامتًا.
     وحدّ الثقة الخارجي (P0.4) كما هو: ردّ المزوّد مشورةٌ نصية فقط؛ لا يُستخرج منه JSON
     ولا تُنفّذ منه أداة. */
  const clinicalCapability = clinicalCapabilityOf({
    role: session.role,
    doctorPartyId,
  });
  const clinicalExternalAllowed = modes.external && controlSettings["ai.clinical_external"] === "true";
  const plan = externalConsultPlan({
    intent: response.intent,
    message: latestUserMsg,
    hasKey: modes.external && settings.hasKey,
    clinicalExternalAllowed,
    clinicalIdentity: clinicalCapability.ok,
  });
  if (plan.kind === "clinical_blocked") {
    response = {
      ...response,
      warnings: [
        ...(response.warnings || []),
        plan.reason === "scope"
          ? CLINICAL_SCOPE_NOTICE
          : "الاستشارة السريرية النصية (دوائية/علاجية) متاحة للحسابات ذات الهوية السريرية — الرد أعلاه من المحرك المحلي ضمن صلاحياتك الإدارية.",
      ],
    };
  } else if (!droppedPatientContext && response.sourceType === "internal_engine" && !response.confirmation && (plan.kind === "clinical" ||
    (plan.kind === "administrative" && conversationPatientId === null))) {
    // Never replace an authoritative database result or a pending signed action with cloud prose.
    // Never export a rejected/unverified patient context, or patient-linked administrative text.
    try {
      // Both cloud paths must mask registered names, including clinical history.
      // A failed name lookup must prevent egress; the catch below keeps the local reply.
      const nameTokens = await personNameTokens();
      const sanitizeOutbound = (content: string) =>
        redactPersonNames(deIdentifyClinicalContext(content), nameTokens);
      const outboundMessages: AiChatMessage[] = plan.kind === "clinical"
        ? [
          { role: "system", content: DENTAL_ASSISTANT_SYSTEM_PROMPT },
          ...incomingMessages.map((m) => ({ role: m.role, content: sanitizeOutbound(m.content) })),
        ]
        : [
          { role: "system", content: ADMIN_ASSISTANT_SYSTEM_PROMPT },
          { role: "user", content: sanitizeOutbound(latestUserMsg) },
        ];

      const cloudResult = await aiChat({
        messages: outboundMessages,
        maxTokens: plan.kind === "clinical" ? 1500 : 800,
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
      } else {
        response = {
          ...response,
          warnings: [...(response.warnings || []), "لم يكتمل الرد من المساعد الخارجي؛ المعروض هو رد المساعد الداخلي."],
        };
      }
    } catch {
      // Do not expose provider errors or imply that a cloud request actually ran.
      response = {
        ...response,
        warnings: [...(response.warnings || []), "لم يكتمل الرد من المساعد الخارجي؛ المعروض هو رد المساعد الداخلي."],
      };
    }
  }

  return replyWithAudit(response, started, user, session);
}

async function replyWithAudit(
  response: StructuredAiResponse,
  started: number,
  user: { id: number; displayName?: string | null; username: string },
  session: { role: string; username: string },
) {
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
  }, { headers: { "Cache-Control": "no-store" } });
}
