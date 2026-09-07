import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername, recordAudit } from "@/lib/db";
import { canUseAiChat } from "@/lib/roles";
import { aiChat, getAiSettings, sanitizeForPrivacy, type AiChatMessage } from "@/lib/ai";
import { generateDentalExpertReply } from "@/lib/dental-ai-engine";
import {
  resolvePatientInquiry,
  resolveClinicOperationsInquiry,
  type AssistantUserContext,
} from "@/lib/assistant-knowledge";

export const dynamic = "force-dynamic";

/**
 * النظام التوجيهي للمساعد السريري والإداري لمركز د. عقلان لطب وتقويم الأسنان.
 * يحقق المادة 214 دستوريًا: الذكاء الاصطناعي يقترح ولا يعتمد.
 */
export const DENTAL_ASSISTANT_SYSTEM_PROMPT = `أنت «المساعد الذكي الشامل لمركز د. عقلان لطب وجراحة وتقويم الأسنان» (Dr. Aqlan Dental Center AI Assistant).
مهمتك: مساعدة الطاقم الطبي والإداري بالمركز في:
1. الاستعلام الفوري عن أي مريض (البيانات، الرصيد المالي والمديونية، المواعيد، الزيارات، التنبيهات الطبية، خطط العلاج).
2. استعراض إحصائيات وعمليات المركز الحية (مواعيد اليوم، نواقص المخزون، قائمة الأطباء، أسعار الخدمات، الصندوق).
3. إرشاد الموظفين حول كيفية استخدام جميع شاشات وخصائص البرنامج خطوة بخطوة.
4. بروتوكولات طب الأسنان السريرية المعتمدة (علاج الجذور والعصب، جراحة الفم والخلع، طب أسنان الأطفال، التركيبات والاستعاضة، الحشوات التجميلية).
5. تشخيصات واستشارات تقويم الأسنان والفكين (تصنيفات Angle، تحليلات السيفالومتري، خطط القلع، أجهزة التثبيت، طوارئ التقويم).
6. دليل الأدوية السنية ومخدرات الأسنان الموضعية وجرعات الكبار والأطفال وموانع الاستعمال.
7. إرشادات ورعاية ما بعد المعالجة والجراحة وتوليد رسائل الواتساب للمرضى.

القواعد الحاكمة الصارمة:
- المادة 214 من الدستور الطبي للمركز: أنت تقترح ولا تعتمد. كل معلومة أو جرعة أو خطة هي استرشادية سريرياً، والقرار النهائي بيد الطبيب المعالج حصراً.
- أسلوب الرد: لغة عربية مهنية واضحة، دقيقة ومباشرة ومنظمة بنقاط وجداول.`;


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

  if (Array.isArray(source.messages) && source.messages.length > 0) {
    for (const m of source.messages) {
      if (m && typeof m === "object") {
        const item = m as Record<string, unknown>;
        const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
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

  const started = Date.now();
  let replyText = "";
  let modelUsed = settings.model || "aqlan-dental-expert-v1";
  let latencyMs = 0;
  let isLocalEngine = false;

  const doctorPartyId = user.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
  const assistantContext: AssistantUserContext = {
    userRole: session.role,
    username: session.username,
    doctorPartyId,
    canViewAllPatients: user.permissions?.canViewAllPatients ?? (session.role !== "doctor"),
    canViewFinancials: user.permissions?.canViewClinicFinance ?? (session.role === "admin" || session.role === "accountant"),
  };

  const latestUserMsg = incomingMessages[incomingMessages.length - 1]?.content || "";

  // استخراج سياق قاعدة البيانات الحية (للمرضى وعمليات المركز)
  const [patientInquiry, clinicOpsInquiry] = await Promise.all([
    resolvePatientInquiry(latestUserMsg, assistantContext).catch(() => null),
    resolveClinicOperationsInquiry(latestUserMsg, assistantContext).catch(() => null),
  ]);

  // المحاولة الأولى: عبر المزوّد السحابي إن وُجد مفتاح ربط محفوظ
  if (settings.hasKey) {
    const outboundMessages: AiChatMessage[] = [
      { role: "system", content: DENTAL_ASSISTANT_SYSTEM_PROMPT },
    ];

    // حقن سياق البيانات الحية (RAG) إن توفر
    const liveContext = patientInquiry?.rawContext || clinicOpsInquiry?.rawContext;
    if (liveContext) {
      outboundMessages.push({
        role: "system",
        content: `[بيانات حية مستخرجة من قاعدة بيانات مركز د. عقلان لطب وتقويم الأسنان]:\n${liveContext}\nاستند إلى هذه الحقائق الدقيقة والموثقة للإجابة عن استفسار المستخدم بوضوح وأمان.`,
      });
    }

    outboundMessages.push(
      ...incomingMessages.map((m) => ({
        role: m.role,
        content: m.role === "system" ? m.content : sanitizeForPrivacy(m.content),
      })),
    );

    const result = await aiChat({
      messages: outboundMessages,
      maxTokens: 1500,
      temperature: 0.3,
    });

    if (result.ok && result.content.trim()) {
      replyText = result.content;
      modelUsed = result.model;
      latencyMs = result.latencyMs;
    } else {
      // احتياطي ذكي: إذا تعذر المزوّد السحابي، يعمل المحرك السريري والإداري المحلي فوراً
      const expert = await generateDentalExpertReply(incomingMessages, assistantContext);
      replyText = expert.reply;
      modelUsed = `${expert.model} (محرك المركز المدمج)`;
      latencyMs = Date.now() - started;
      isLocalEngine = true;
    }
  } else {
    // المحرك السريري والإداري الذكي المدمج يعمل مباشرة عند عدم وجود مفتاح سحابي
    const expert = await generateDentalExpertReply(incomingMessages, assistantContext);
    replyText = expert.reply;
    modelUsed = `${expert.model} (محرك المركز المدمج)`;
    latencyMs = Date.now() - started;
    isLocalEngine = true;
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
        model: modelUsed,
        latencyMs,
        isLocalEngine,
      },
      actor: session.username,
      actorRole: session.role,
    });
  } catch {
    // فشل التدقيق لا يعطل خدمة المساعد
  }

  return NextResponse.json({
    ok: true,
    reply: replyText,
    model: modelUsed,
    latencyMs,
    isLocalEngine,
  });
}

