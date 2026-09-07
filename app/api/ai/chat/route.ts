import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { findUserByUsername, recordAudit } from "@/lib/db";
import { canUseAiChat } from "@/lib/roles";
import { aiChat, getAiSettings, sanitizeForPrivacy, type AiChatMessage } from "@/lib/ai";
import { generateDentalExpertReply } from "@/lib/dental-ai-engine";

export const dynamic = "force-dynamic";

/**
 * النظام التوجيهي للمساعد السريري والإداري لمركز د. عقلان لطب وتقويم الأسنان.
 * يحقق المادة 214 دستوريًا: الذكاء الاصطناعي يقترح ولا يعتمد.
 */
export const DENTAL_ASSISTANT_SYSTEM_PROMPT = `أنت «المساعد الذكي لمركز د. عقلان لطب وجراحة وتقويم الأسنان» (Dr. Aqlan Dental Center AI Assistant).
مهمتك: مساعدة الطاقم الطبي والإداري بالمركز في:
1. بروتوكولات طب الأسنان السريرية المعتمدة (علاج الجذور والعصب، جراحة الفم والخلع، طب أسنان الأطفال، التركيبات والاستعاضة، الحشوات التجميلية).
2. تشخيصات واستشارات تقويم الأسنان والفكين (تصنيفات Angle، تحليلات السيفالومتري، خطط القلع، أجهزة التثبيت، حلول الطوارئ التقويمية).
3. دليل الأدوية السنية: الجرعات الدقيقة للبالغين والأطفال، المضادات الحيوية، المسكنات ومضادات الالتهاب، مخدرات الأسنان الموضعية وموانع الاستعمال لمرضى الضغط والقلب والحوامل.
4. إرشادات ما بعد المعالجة والجراحة لنقلها للمرضى.
5. الاستفسارات التشغيلية وسياسات العيادة وتنظيم المواعيد.

القواعد الحاكمة الصارمة:
- المادة 214 من الدستور الطبي للمركز: أنت تقترح ولا تعتمد. كل معلومة أو جرعة أو خطة هي استرشادية سريرياً، والقرار النهائي بيد الطبيب المعالج حصراً.
- أسلوب الرد: لغة عربية مهنية واضحة، علمية وموجزة ومباشرة، مع نقاط وجداول عند الحاجة.
- في استفسارات الأدوية: اذكر الاسم العلمي والجرعة المعتادة بالميليجرام وموانع الاستعمال بدقة.`;

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

  // المحاولة الأولى: عبر المزوّد السحابي إن وُجد مفتاح ربط محفوظ
  if (settings.hasKey) {
    const outboundMessages: AiChatMessage[] = [
      { role: "system", content: DENTAL_ASSISTANT_SYSTEM_PROMPT },
      ...incomingMessages.map((m) => ({
        role: m.role,
        content: m.role === "system" ? m.content : sanitizeForPrivacy(m.content),
      })),
    ];

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
      // احتياطي ذكي: إذا تعذر المزوّد السحابي، يعمل المحرك السريري المحلي فوراً
      const expert = await generateDentalExpertReply(incomingMessages);
      replyText = expert.reply;
      modelUsed = `${expert.model} (محرك سريري محلي مدمج)`;
      latencyMs = Date.now() - started;
      isLocalEngine = true;
    }
  } else {
    // المحرك السريري الذكي المدمج يعمل مباشرة عند عدم وجود مفتاح سحابي
    const expert = await generateDentalExpertReply(incomingMessages);
    replyText = expert.reply;
    modelUsed = `${expert.model} (المحرك السريري المدمج)`;
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

