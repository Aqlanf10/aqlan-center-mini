/**
 * محرك الفهم الطبيعي وتوجيه النوايا الذكي (Aqlan Assistant NLU & Intent Engine)
 *
 * يدعم:
 * 1. اللغة العربية الفصحى واللهجة اليمنية الدارجة في العيادات.
 * 2. التعرف على التواريخ والعملات والتخصصات بدقة.
 * 3. سياق المحادثة الممتد (الربط التلقائي للمريض في الأسئلة اللاحقة).
 * 4. حماية صارمة ضد محاولات كسر القيود (Prompt Injection Defense).
 */

import type { AiToolContext, StructuredAiResponse, ToolExecutionResult } from "./ai-tools/types";
import { executeAiTool } from "./ai-tools/registry";
import { generateDentalExpertReply } from "./dental-ai-engine";
import { extractPatientIdentifier } from "./assistant-knowledge";
import type { PeriodPreset, CurrencyFilter } from "./reports-types";
import { addDays } from "./schedule";

/**
 * فحص محاولات حقن الأوامر والتلاعب بالصلاحيات (Prompt Injection)
 */
export function detectPromptInjection(query: string): boolean {
  const norm = query.toLowerCase();
  const injectionPatterns = [
    "تجاهل التعليمات",
    "تجاهل كل التعليمات",
    "تجاهل الأوامر",
    "ignore all instructions",
    "ignore previous instructions",
    "أنا المدير",
    "أنا مدير المركز",
    "أعطني صلاحية",
    "تجاهل الصلاحيات",
    "تخطي الصلاحيات",
    "database_url",
    "session_secret",
    "select * from",
    "drop table",
    "delete from",
    "union select",
    "اطبع المتغيرات",
    "اطبع المفاتيح",
    "api key",
    "اعطني كلمة المرور",
    "اعرض حسابات الأطباء",
  ];

  return injectionPatterns.some((pattern) => norm.includes(pattern));
}

/**
 * استخراج العملة المستهدفة من السؤال (YER, SAR, USD)
 */
export function extractCurrency(text: string): CurrencyFilter {
  const norm = text.toLowerCase();
  if (norm.includes("دولار") || norm.includes("usd") || norm.includes("$")) {
    return "USD";
  }
  if (norm.includes("سعودي") || norm.includes("sar") || norm.includes("ريال سعودي")) {
    return "SAR";
  }
  if (norm.includes("يمني") || norm.includes("yer") || norm.includes("ريال يمني") || norm.includes("بالريال")) {
    return "YER";
  }
  return "all";
}

/**
 * استخراج الفترة الزمنية المحددة من السؤال
 */
export function extractPeriodPreset(text: string): PeriodPreset {
  const norm = text.toLowerCase();
  if (norm.includes("أمس") || norm.includes("البارحة")) return "yesterday";
  if (norm.includes("اليوم") || norm.includes("الليلة")) return "today";
  if (norm.includes("هذا الأسبوع") || norm.includes("الاسبوع الحالي")) return "this_week";
  if (norm.includes("الشهر الماضي") || norm.includes("الشهر السابق")) return "prev_month";
  if (norm.includes("هذا الشهر") || norm.includes("الشهر الحالي")) return "this_month";
  if (norm.includes("هذا الربع") || norm.includes("الربع الحالي")) return "this_quarter";
  if (norm.includes("السنة الماضية") || norm.includes("العام الماضي")) return "prev_year";
  if (norm.includes("هذه السنة") || norm.includes("هذا العام") || norm.includes("سنوي") || norm.includes("السنوي")) return "this_year";
  return "this_month";
}

/**
 * استخراج التخصص المستهدف من السؤال
 */
export function extractSpecialty(text: string): string | undefined {
  const norm = text.toLowerCase();
  if (norm.includes("تقويم")) return "ortho";
  if (norm.includes("زراع")) return "implant";
  if (norm.includes("عصب") || norm.includes("جذور")) return "endo";
  if (norm.includes("تركيب") || norm.includes("تاج") || norm.includes("زركون") || norm.includes("بورسلان") || norm.includes("جسر")) return "prostho";
  if (norm.includes("حشو")) return "restorative";
  if (norm.includes("خلع") || norm.includes("جراح")) return "surgery";
  if (norm.includes("أطفال") || norm.includes("طفل")) return "pediatric";
  if (norm.includes("تنظيف") || norm.includes("لثة") || norm.includes("تبييض")) return "perio";
  return undefined;
}

/**
 * فحص ما إذا كان السؤال استفساراً متابعاً لمريض سابق (Follow-up pronoun query)
 */
export function isPatientFollowupQuery(query: string): boolean {
  const norm = query.toLowerCase().trim();
  const followupTriggers = [
    "موعده", "موعدها", "حسابه", "حسابها", "كم دفع", "كم دفعت",
    "علاجه", "علاجها", "خطته", "خطتها", "تلفونه", "تلفونها", "هاتفه", "هاتفها",
    "ملفه", "ملفها", "عنده", "عندها", "مستحقاته", "مستحقاتها", "رصيده", "رصيدها",
  ];
  return followupTriggers.some((tr) => norm.includes(tr));
}

/**
 * استخراج رقم الهاتف (اليمني والدولي)
 */
export function extractPhoneNumber(text: string): string | undefined {
  const match = text.match(/(?:\+?967|0)?([1-7]\d{7,8}|7[01378]\d{7})/);
  return match ? match[0] : undefined;
}

/**
 * استخراج التاريخ المباشر من النص للأوامر والعمليات
 */
export function extractActionDate(text: string, todayISO: string): string {
  const norm = text.toLowerCase();
  if (norm.includes("بكرة") || norm.includes("غدا") || norm.includes("غداً") || norm.includes("tomorrow")) {
    return addDays(todayISO, 1);
  }
  if (norm.includes("بعد بكرة") || norm.includes("بعد غد") || norm.includes("بعد غداً")) {
    return addDays(todayISO, 2);
  }
  if (norm.includes("أمس") || norm.includes("البارحة")) {
    return addDays(todayISO, -1);
  }
  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  return todayISO;
}

/**
 * استخراج الوقت من النص
 */
export function extractActionTime(text: string): string {
  const norm = text.toLowerCase();
  const timeMatch = text.match(/(?:الساعة\s*)?(\d{1,2})(?::(\d{2}))?\s*(صباحا|صباحاً|عصرا|عصراً|مساء|مساءً|م|ص)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? timeMatch[2].padStart(2, "0") : "00";
    const modifier = (timeMatch[3] || "").toLowerCase();

    if ((modifier.includes("عصر") || modifier.includes("مساء") || modifier === "م") && hours < 12) {
      hours += 12;
    } else if (modifier.includes("صباح") && hours === 12) {
      hours = 0;
    } else if (!modifier && hours >= 1 && hours <= 8) {
      hours += 12;
    }

    return `${String(hours).padStart(2, "0")}:${minutes}`;
  }
  return "16:00";
}

/**
 * استخراج المبالغ المالية من النص
 */
export function extractMoneyAmount(text: string): number | undefined {
  const match = text.match(/(?:مبلغ|دفعة|سداد|سند|بمبلغ)?\s*(\d+(?:[.,]\d+)?)\s*(?:ألف|الف|k|ريال|دولار|\$|yer|sar|usd)?/i);
  if (match) {
    let val = parseFloat(match[1].replace(/,/g, ""));
    if (!isNaN(val)) {
      if (text.includes("ألف") || text.includes("الف") || text.toLowerCase().includes("k")) {
        val *= 1000;
      }
      return val;
    }
  }
  return undefined;
}

/**
 * استخراج اسم المريض من سياق الأمر التنفيذي
 */
export function extractPatientNameFromAction(text: string): string | undefined {
  const match = text.match(/(?:للمريض|للمريضة|المريض|المريضة|باسم|اسمه|اسمها)\s+([^\d,.:؛!?\n]+?)(?=\s+(?:هاتف|تلفون|رقم|غدا|غداً|بكرة|اليوم|الساعة|عنده|عندها|مبلغ|دفعة|ريال|دولار|كشف|تقويم|عصب|لون|بالموعد|بالحضور|بشأن|حول|عن|$))/i);
  if (match && match[1]) {
    const cleaned = match[1].trim();
    if (cleaned.length >= 2 && !["جديد", "جديدة", "سابق", "حالي"].includes(cleaned)) {
      return cleaned;
    }
  }
  return extractPatientIdentifier(text) ?? undefined;
}

/**
 * استخراج اسم المريض من سياق الأمر التنفيذي مع دعم الذاكرة السياقية وتاريخ المحادثة وفك الضمائر (له/لها/المريض)
 */
export function extractPatientNameWithHistory(
  text: string,
  history: Array<{ role: string; content: string }> = [],
  context?: AiToolContext,
): string | undefined {
  const direct = extractPatientNameFromAction(text);
  const hasPronoun = /(?:^|\s)(?:له|لها|عنده|عندها)(?:\s|$)/i.test(text);
  const isInvalidDirect =
    !direct ||
    ["له", "لها", "المريض", "المريضة", "عنده", "عندها", "جديد", "جديدة", "موعد"].includes(direct.trim()) ||
    direct.includes("الساعة") ||
    direct.includes("غدا") ||
    direct.includes("غداً") ||
    direct.includes("بكرة") ||
    direct.includes("اليوم") ||
    direct.includes("صباح") ||
    direct.includes("عصر") ||
    direct.includes("مساء") ||
    direct.includes("خطة") ||
    direct.includes("علاج") ||
    direct.includes("تقويم") ||
    direct.includes("زراعة") ||
    direct.includes("مبلغ") ||
    direct.includes("أقساط") ||
    direct.includes("اقساط") ||
    direct.includes("ألف") ||
    direct.includes("الف") ||
    direct.includes("ريال") ||
    direct.includes("دولار") ||
    direct.includes("تاج") ||
    direct.includes("معمل") ||
    direct.includes("تقرير") ||
    direct.includes("استمارة") ||
    /\d/.test(direct);

  if (!isInvalidDirect && !hasPronoun) {
    return direct;
  }

  // إذا كانت الرسالة تحتوي على ضمير يعود على مريض سابق (له، لها، عنده، عندها، للمريض) أو كان الاسم المباشر غير صالح
  if (
    hasPronoun ||
    /(?:للمريض|للمريضة|المريض|المريضة)/i.test(text) ||
    isInvalidDirect
  ) {
    if (context?.currentPatientName) {
      return context.currentPatientName;
    }

    // فحص رسائل المحادثة السابقة من الأحدث إلى الأقدم
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]?.content || "";

      // 1. فحص أنماط ذكر المريض الصريحة مثل: على المريض كمال، للمريض فلان، المريض فلان
      const matchExplicit = msg.match(/(?:على المريض|للمريض|المريض الجديد|المريض|المريضة|باسم|ملف المريض|حساب المريض)[:\s*]+([^\d,.:؛!?\n*()?]+)/i);
      if (matchExplicit && matchExplicit[1]) {
        const cleaned = matchExplicit[1].trim();
        if (
          cleaned.length >= 3 &&
          !["جديد", "جديدة", "سابق", "حالي", "المركز", "المساعد", "الدكتور", "له", "لها"].includes(cleaned) &&
          !cleaned.includes("الساعة") &&
          !cleaned.includes("غدا")
        ) {
          return cleaned;
        }
      }

      // 2. فحص الاستخراج العام من الرسالة السابقة
      const fromPast = extractPatientNameFromAction(msg);
      if (
        fromPast &&
        !["له", "لها", "المريض", "المريضة", "جديد", "جديدة"].includes(fromPast) &&
        !fromPast.includes("الساعة") &&
        !fromPast.includes("غدا") &&
        !fromPast.includes("غداً")
      ) {
        return fromPast;
      }
    }
  }

  return isInvalidDirect ? undefined : direct;
}

/**
 * محرك المعالجة الشامل لكافة استفسارات المساعد الذكي.
 *
 * هذا الغلاف يلتقط عرض التأكيد المعلّق الذي أنتجته أداة تغيير حالة داخل
 * المعالجة (بوابة السياسة المركزية) ويربطه بالاستجابة — فتراه الواجهة وتعرضه
 * بأزرار «تأكيد التنفيذ / إلغاء» مهما كان المسار الذي أنتج الإجراء.
 */
export async function processAssistantQuery(
  latestMessage: string,
  context: AiToolContext,
  conversationHistory: Array<{ role: "user" | "assistant" | "system"; content: string }> = [],
): Promise<StructuredAiResponse> {
  const response = await processAssistantQueryImpl(latestMessage, context, conversationHistory);
  const pending = context.pendingConfirmation;
  if (pending && !response.confirmation) {
    response.confirmation = pending;
  }
  return response;
}

async function processAssistantQueryImpl(
  latestMessage: string,
  context: AiToolContext,
  conversationHistory: Array<{ role: "user" | "assistant" | "system"; content: string }> = [],
): Promise<StructuredAiResponse> {
  const started = Date.now();
  const trimmed = latestMessage.trim();
  const norm = trimmed.toLowerCase();

  // 1. فحص محاولات حقن التعليمات ومقاومة التلاعب
  if (detectPromptInjection(trimmed)) {
    return {
      answer: `🔒 **تنبيه أمني وحوكمة:**\nلا يمكن تعديل الصلاحيات أو تجاوز قواعد الأمان وعزل الأطباء عبر الأوامر النصية.\nيتم التحقق من الصلاحيات حصراً عبر جلسة الخادم الموثقة (دورك الحالي: **${context.role}**).`,
      intent: "security_rejection",
      toolsUsed: ["prompt_injection_guard"],
      warnings: ["محاولة تجاوز أمني مرفوضة"],
      sourceType: "internal_engine",
      model: "aqlan-security-guard",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 2. فحص استفسارات دليل استخدام النظام (System Feature Guide)
  if (
    norm.includes("كيف أضيف") ||
    norm.includes("كيف اعمل") ||
    norm.includes("كيف أعمل") ||
    norm.includes("كيف احجز") ||
    norm.includes("كيف أحجز") ||
    norm.includes("أين أغير") ||
    norm.includes("كيف أغير") ||
    norm.includes("كيف أفتح") ||
    norm.includes("كيف افتح") ||
    norm.includes("كيف أضبط") ||
    norm.includes("كيف اضبط") ||
    norm.includes("كيف أستخدم") ||
    norm.includes("كيف استخدم") ||
    norm.includes("أين شاشة") ||
    norm.includes("اين شاشة") ||
    norm.includes("طريقة استخدام") ||
    norm.includes("خطوات") ||
    norm.includes("دليل استخدام") ||
    norm.includes("كيف أسجل") ||
    norm.includes("كيف اسجل")
  ) {
    const guideResult = await executeAiTool("get_system_guide", { query: trimmed }, context);
    if (guideResult.success) {
      return {
        answer: guideResult.textSummary,
        intent: "system_guide",
        toolsUsed: ["get_system_guide"],
        actions: guideResult.actions,
        sourceType: "internal_engine",
        model: "aqlan-system-guide",
        latencyMs: Date.now() - started,
        generatedAt: new Date().toISOString(),
      };
    }
  }

  // ─── 3. تنفيذ العمليات والإجراءات التشغيلية المباشرة (Operational Actions Execution) ──

  // أ) أمر تسجيل / إضافة مريض جديد
  if (
    (/(?:أضف|اضف|تسجيل|سجل|إضافة|اضافة)\s+(?:مريض|حالة|ملف)\s+(?:جديد|جديدة)?/i.test(norm) ||
     /(?:فتح|افتح)\s+ملف\s+(?:مريض|جديد)/i.test(norm)) &&
    !norm.includes("كيف")
  ) {
    const pName = extractPatientNameFromAction(trimmed);
    const pPhone = extractPhoneNumber(trimmed);
    const pGender = (norm.includes("أنثى") || norm.includes("بنت") || norm.includes("طفلة") || norm.includes("مريضة")) ? "female" : "male";
    
    let medAlert: string | undefined = undefined;
    const alertMatch = trimmed.match(/(?:عنده|عندها|حساسية|يعاني من|تنبيه)[:\s]+([^\n.]+)/i);
    if (alertMatch) medAlert = alertMatch[1].trim();

    if (pName) {
      const actionRes = await executeAiTool(
        "create_patient",
        { fullName: pName, phone: pPhone, gender: pGender, medicalAlert: medAlert },
        context,
      );
      return {
        answer: actionRes.textSummary,
        intent: "action_create_patient",
        toolsUsed: ["create_patient"],
        cards: actionRes.cards,
        actions: actionRes.actions,
        sourceType: "live_database",
        model: "aqlan-action-engine",
        latencyMs: Date.now() - started,
        generatedAt: new Date().toISOString(),
      };
    }
  }

  // ب) أمر حجز موعد مباشر
  if (
    (/(?:احجز|حجز|سجل|اعط|اعطي|جدول|اشتي\s+احجز|شتي\s+احجز|نشتي\s+نحجز|ودنا\s+نحجز)(?:\s+(?:له|لها|لهم|للمريض|للمريضة))?\s+(?:موعد|حجز|جلسة|جلسة\s+شد)/i.test(norm) ||
     /(?:حجز|احجز)\s+(?:موعد|جلسة|للمريض|له|لها)/i.test(norm) ||
     /(?:جلسة\s+شد|شد\s+تقويم)\s+(?:للمريض|له|لها)/i.test(norm)) &&
    !norm.includes("كيف") && !norm.includes("مواعيد اليوم")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    const pDate = extractActionDate(trimmed, context.todayISO || new Date().toISOString().slice(0, 10));
    const pTime = extractActionTime(trimmed);
    const pSpecialty = extractSpecialty(trimmed);

    const actionRes = await executeAiTool(
      "book_appointment",
      {
        patientName: pName,
        date: pDate,
        time: pTime,
        appointmentType: pSpecialty ? (pSpecialty === "ortho" ? "شد تقويم" : pSpecialty === "endo" ? "علاج عصب" : "كشف ومعاينة") : (norm.includes("شد") ? "شد تقويم" : "كشف عام"),
      },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_book_appointment",
      toolsUsed: ["book_appointment"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // ج) أمر تعديل حالة الموعد (وصول صالة / إلغاء / إنهاء)
  if (
    /(?:المريض\s+حضر|حضر\s+المريض|سجل\s+وصول|وصل\s+المريض|ألغ\s+موعد|الغ\s+موعد|إلغاء\s+موعد|الغاء\s+موعد|لم\s+يحضر|تغيب\s+عن\s+الموعد|وصل\s+حق\s+التقويم)/i.test(norm) &&
    !norm.includes("كيف")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    let act: "arrive" | "cancel" | "no_show" = "arrive";
    if (norm.includes("ألغ") || norm.includes("الغ") || norm.includes("إلغاء") || norm.includes("الغاء")) {
      act = "cancel";
    } else if (norm.includes("لم يحضر") || norm.includes("تغيب")) {
      act = "no_show";
    }

    const actionRes = await executeAiTool(
      "update_appointment_status",
      { patientName: pName, action: act },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_update_appointment",
      toolsUsed: ["update_appointment_status"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // د) أمر تسجيل سند قبض / دفعة مالية
  if (
    (/(?:سجل|تسجيل|قبض|سند\s+قبض|استلمت|استلام)\s+(?:دفعة|سند|مبلغ|فلوس|سداد|بيزة)/i.test(norm) ||
     /(?:سدد|دفع)\s+(?:المريض|له|لها)/i.test(norm)) &&
    !norm.includes("كيف") && !norm.includes("كم دفع") && !norm.includes("كم استلمنا")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    const amount = extractMoneyAmount(trimmed) || 0;
    const curr = extractCurrency(trimmed);
    const method = (norm.includes("تحويل") || norm.includes("كريمي") || norm.includes("بنك")) ? "transfer" : "cash";

    const actionRes = await executeAiTool(
      "record_patient_payment",
      {
        patientName: pName,
        amount,
        currency: curr === "all" ? "YER" : curr,
        method,
      },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_record_payment",
      toolsUsed: ["record_patient_payment"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // هـ) أمر إضافة تنبيه طبي أو حساسية
  if (
    (/(?:أضف|اضف|سجل|تثبيت)\s+(?:تنبيه\s+طبي|حساسية|مرض\s+مزمن)/i.test(norm) ||
     /(?:عنده|عندها)\s+(?:حساسية\s+بنسلين|سكر|ضغط|نزيف|ربو)/i.test(norm)) &&
    !norm.includes("كيف")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    let alertText = trimmed;
    const match = trimmed.match(/(?:تنبيه\s+طبي|حساسية|عنده|عندها|يعاني من)(?:\s+للمريض\s+[^\s:]+)?[:\s]+([^\n.]+)/i);
    if (match) {
      alertText = match[1].trim();
    }

    const actionRes = await executeAiTool(
      "add_patient_medical_alert",
      { patientName: pName, medicalAlert: alertText },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_medical_alert",
      toolsUsed: ["add_patient_medical_alert"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // و) أمر معمل وتركيبات
  if (
    (/(?:طلب|أمر|ارسل|أرسل)\s+(?:معمل|للمعمل|للمختبر|تركيبة|تاج|زركون)/i.test(norm)) &&
    !norm.includes("حالات المعمل") && !norm.includes("ما هي") && !norm.includes("كيف") &&
    !norm.includes("عبي") && !norm.includes("نموذج") && !norm.includes("استمارة") && !norm.includes("مواصفات")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    let shade = "A2";
    const shadeMatch = trimmed.match(/\b([A-D][1-4]|BL[1-4])\b/i);
    if (shadeMatch) shade = shadeMatch[1].toUpperCase();

    const actionRes = await executeAiTool(
      "create_lab_order",
      { patientName: pName, shade, serviceName: norm.includes("زركون") ? "تاج زركونيوم" : "تركيبة سنية" },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_lab_order",
      toolsUsed: ["create_lab_order"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // ز) أمر حركة مخزون
  if (
    /(?:أضف\s+مخزون|اضف\s+مخزون|توريد\s+مادة|صرف\s+مادة|استهلاك\s+مادة|أضف\s+للمخزن|اصرف\s+من\s+المخزون|صرف\s+من\s+المخزون|سجل\s+صرف|سجل\s+استهلاك|سجل\s+توريد|أدخل\s+وارد)/i.test(norm) &&
    !norm.includes("كيف")
  ) {
    const qtyMatch = trimmed.match(/(\d+)/);
    const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
    const kind = (norm.includes("صرف") || norm.includes("استهلاك") || norm.includes("اصرف")) ? "out" : "in";
    let itemName = "مادة سنية";
    if (norm.includes("بنج") || norm.includes("ليدوكايين")) itemName = "بنج";
    else if (norm.includes("قفازات")) itemName = "قفازات";
    else if (norm.includes("كمامات")) itemName = "كمامات";
    else if (norm.includes("كومبوزيت") || norm.includes("كمبوزيت")) itemName = "كومبوزيت";
    else {
      const itemMatch = trimmed.match(/(?:مادة|بند)\s+([^\d,.:؛!?\n]+)/i);
      if (itemMatch && itemMatch[1]) itemName = itemMatch[1].trim();
    }

    const actionRes = await executeAiTool(
      "record_inventory_movement",
      { itemName, kind, qty },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_inventory_movement",
      toolsUsed: ["record_inventory_movement"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // ح) أمر تجهيز رسالة واتساب
  if (
    /(?:رسالة\s+واتساب|تذكير\s+واتساب|أرسل\s+واتساب|ارسل\s+واتساب|واتس\s+للمريض|رسل\s+له\s+واتس)/i.test(norm) &&
    !norm.includes("كيف")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    let type: "appointment" | "balance_due" | "postop" = "appointment";
    if (norm.includes("حساب") || norm.includes("مديونية") || norm.includes("متبقي")) {
      type = "balance_due";
    } else if (norm.includes("خلع") || norm.includes("جراحة") || norm.includes("بعد العلاج")) {
      type = "postop";
    }

    const actionRes = await executeAiTool(
      "generate_whatsapp_reminder",
      { patientName: pName, type },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_whatsapp",
      toolsUsed: ["generate_whatsapp_reminder"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // ط) أمر الروشتة الطبية وفحص الأمان الدوائي المعتمد
  if (
    (/(?:روشتة|وصفة\s+طبية|وصفة\s+علاج|اكتب\s+علاج|اكتب\s+له\s+علاج|اقترح\s+علاج|اصرف\s+علاج|علاج\s+دوائي|اكتب\s+روشتة|روشتة\s+للمريض|أدوية\s+للمريض)/i.test(norm) ||
     (/(?:أدوية|مسكن|مضاد)\s+(?:للمريض|له|لها)/i.test(norm))) &&
    !norm.includes("كيف") && !norm.includes("ما هو") && !norm.includes("ما هي") && !norm.includes("بروتوكول")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    let condition = "ألم أسنان والتهاب";
    if (norm.includes("خلع") || norm.includes("جراحة") || norm.includes("عقل")) condition = "بعد الخلع الجراحي";
    else if (norm.includes("عصب") || norm.includes("لب") || norm.includes("خراج")) condition = "التهاب عصب وخراج لثوي";
    else if (norm.includes("تقويم")) condition = "ألم شد التقويم";

    const actionRes = await executeAiTool(
      "recommend_prescription",
      { patientName: pName, condition },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_prescription_safety",
      toolsUsed: ["recommend_prescription"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // ي) إرشادات وتعليمات ما بعد الإجراء السني
  if (
    (/(?:إرشادات|ارشادات|تعليمات|نصائح)\s+(?:ما\s+بعد|بعد|العناية\s+بعد)\s+(?:الخلع|الزراعة|العصب|التقويم|التبييض|الجراحة|الحشو|العلاج)/i.test(norm)) &&
    !norm.includes("كيف")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    const actionRes = await executeAiTool(
      "generate_post_op_care",
      { patientName: pName, procedureType: trimmed },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_post_op_care",
      toolsUsed: ["generate_post_op_care"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // ك) استعلام أسعار وخدمات المركز الرسمية
  if (
    (/(?:كم\s+اسعار|كم\s+أسعار|كم\s+سعر|بكم|اسعار|أسعار|تكلفة|كم\s+تكلفة|سعر|قائمة\s+الأسعار|دليل\s+الأسعار)\s*(?:الزراعة|زراعة|التقويم|تقويم|الحشوة|حشوة|الحشوات|حشوات|العصب|عصب|الخلع|خلع|التاج|تاج|الزركون|زركون|الزيركون|زيركون|الفينير|فينير|التبييض|تبييض|الأشعة|أشعة|الاشعة|اشعة|تنظيف|الخدمات|خدمات|الاسنان|الأسنان)?/i.test(norm)) ||
    (/(?:بكم\s+الزراعة|بكم\s+التقويم|بكم\s+التبييض|بكم\s+الزركون|بكم\s+الفينير|بكم\s+نزع\s+العصب|بكم\s+سحب\s+العصب|قائمة\s+الأسعار|اسعار\s+المركز|أسعار\s+المركز)/i.test(norm)) ||
    (norm.includes("اسعار") && (norm.includes("مركز") || norm.includes("عندكم") || norm.includes("خدمات")))
  ) {
    const actionRes = await executeAiTool(
      "get_service_pricing",
      { query: trimmed },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_service_pricing",
      toolsUsed: ["get_service_pricing"],
      table: actionRes.table,
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // ل) أمر صياغة وتعبئة إقرار الموافقة الطبية المستنيرة
  if (
    (/(?:إقرار|اقرار|موافقة|استمارة\s+موافقة|نموذج\s+موافقة|نموذج\s+إقرار|عبي\s+إقرار|عبي\s+اقرار|جهز\s+إقرار|جهز\s+اقرار)\s*(?:الخلع|خلع|الزراعة|زراعة|العصب|عصب|التقويم|تقويم|التبييض|تبييض|الجراحة|جراحة|طبي)?/i.test(norm)) &&
    !norm.includes("كيف")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    const toothMatch = trimmed.match(/(?:سن|ضرس|رقم|منطقة)\s+(\d{1,2})/i);
    const toothNumber = toothMatch ? toothMatch[1] : undefined;

    const actionRes = await executeAiTool(
      "draft_consent_form",
      { patientName: pName, procedureType: trimmed, toothNumber },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_draft_consent",
      toolsUsed: ["draft_consent_form"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // م) أمر صياغة وتعبئة خطة العلاج واتفاقية الأقساط
  if (
    (/(?:خطة\s+علاج|اتفاقية\s+علاج|جدول\s+أقساط|جدول\s+اقساط|أقساط\s+علاج|اقساط\s+علاج|عقد\s+علاج|عقد\s+تقويم|عقد\s+زراعة|عبي\s+خطة|جهز\s+خطة)/i.test(norm) ||
     /(?:أقساط|اقساط|دفعة\s+أولى|دفعة\s+اولى)\s+(?:للمريض|له|لها)/i.test(norm)) &&
    !norm.includes("كيف")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    const totalCost = extractMoneyAmount(trimmed) || 300000;
    const rawCurr = extractCurrency(trimmed);
    const currency = (rawCurr === "USD" || rawCurr === "SAR" || rawCurr === "YER") ? rawCurr : "YER";
    const instMatch = trimmed.match(/(\d+)\s+(?:أقساط|اقساط|دفعات|اشهر|أشهر)/i);
    const installmentsCount = instMatch ? parseInt(instMatch[1], 10) : undefined;
    let planTitle = "خطة معالجة سريرية متكاملة";
    if (norm.includes("تقويم")) planTitle = "خطة علاج وتقويم شاملة";
    else if (norm.includes("زراعة") || norm.includes("زرع")) planTitle = "خطة زراعة وتعويضات سنية";
    else if (norm.includes("عصب") || norm.includes("جذور")) planTitle = "خطة علاج لب وجذور وتيجان";

    const actionRes = await executeAiTool(
      "draft_treatment_plan_form",
      { patientName: pName, planTitle, totalCost, currency, installmentsCount },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_draft_treatment_plan",
      toolsUsed: ["draft_treatment_plan_form"],
      table: actionRes.table,
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // ن) أمر تعبئة وصياغة مواصفات وأمر عمل المعمل
  if (
    (/(?:عبي\s+أمر\s+معمل|عبي\s+طلب\s+معمل|نموذج\s+معمل|مواصفات\s+معمل|استمارة\s+معمل|طلب\s+تركيبة|أمر\s+تركيبة)/i.test(norm) ||
     /(?:مواصفات\s+المعمل|مواصفات\s+التركيبة|طلب\s+المعمل)\s+(?:للمريض|له|لها)/i.test(norm)) &&
    !norm.includes("كيف") && !norm.includes("حالات المعمل")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    const toothMatch = trimmed.match(/(?:سن|ضرس|رقم|سنّ)\s+(\d{1,2})/i);
    const toothCode = toothMatch ? toothMatch[1] : undefined;
    const shadeMatch = trimmed.match(/\b([A-D][1-4]|BL[1-4])\b/i);
    const shade = shadeMatch ? shadeMatch[1].toUpperCase() : undefined;
    let restorationType = "تاج زركونيا كامل التشريح";
    if (norm.includes("ايماكس") || norm.includes("إيماكس") || norm.includes("emax")) restorationType = "تاج / قشرة E.max تجميلية";
    else if (norm.includes("فينير") || norm.includes("قشرة")) restorationType = "قشرة خزفية تجميلية (Veneer)";
    else if (norm.includes("بورسلان") || norm.includes("معدن")) restorationType = "تاج بورسلان مدمج بمعدن (PFM)";

    const actionRes = await executeAiTool(
      "draft_lab_order_form",
      { patientName: pName, toothCode, shade, restorationType },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_draft_lab_order",
      toolsUsed: ["draft_lab_order_form"],
      table: actionRes.table,
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // س) أمر تعبئة استمارة الفحص الأولي والتاريخ المرضي
  if (
    (/(?:استمارة\s+فحص|استمارة\s+مريض|نموذج\s+فحص|نموذج\s+مريض|سيرة\s+مرضية|تاريخ\s+مرضي|عبي\s+استمارة|عبي\s+بيانات)\s*(?:مريض|أولي|جديد)?/i.test(norm)) &&
    !norm.includes("كيف")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || undefined;
    const phone = extractPhoneNumber(trimmed);
    const gender = (norm.includes("أنثى") || norm.includes("بنت") || norm.includes("مريضة")) ? "female" : "male";
    let complaint: string | undefined = undefined;
    const compMatch = trimmed.match(/(?:يشتكي من|يعاني من|شكوى|ألم في|مشكلة في)[:\s]+([^\n.]+)/i);
    if (compMatch) complaint = compMatch[1].trim();

    const actionRes = await executeAiTool(
      "draft_patient_intake_form",
      { fullName: pName, phone, gender, chiefComplaint: complaint, medicalHistory: trimmed },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_draft_intake",
      toolsUsed: ["draft_patient_intake_form"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // ع) أمر صياغة التقرير الطبي والشهادة السريرية
  if (
    (/(?:تقرير\s+طبي|تقرير\s+علاج|شهادة\s+طبية|تقرير\s+سريري|اكتب\s+تقرير|صيغ\s+تقرير|تقرير\s+للمريض|تقرير\s+له|تقرير\s+لها)/i.test(norm)) &&
    !norm.includes("كيف") && !norm.includes("تقرير مالي") && !norm.includes("تقرير الإيراد")
  ) {
    const pName = extractPatientNameWithHistory(trimmed, conversationHistory, context) || context.currentPatientName || undefined;
    let addressedTo = "إلى من يهمه الأمر";
    if (norm.includes("تأمين") || norm.includes("التأمين")) addressedTo = "شركة التأمين الصحي";
    else if (norm.includes("عمل") || norm.includes("العمل") || norm.includes("دوام")) addressedTo = "جهة عمل المريض المحترمين";

    const daysMatch = trimmed.match(/(\d+)\s+(?:أيام|ايام|يوم)\s+(?:راحة|إجازة|اجازة)/i);
    const sickLeaveDays = daysMatch ? parseInt(daysMatch[1], 10) : undefined;

    const actionRes = await executeAiTool(
      "draft_medical_report_form",
      { patientName: pName, addressedTo, sickLeaveDays },
      context,
    );
    return {
      answer: actionRes.textSummary,
      intent: "action_draft_medical_report",
      toolsUsed: ["draft_medical_report_form"],
      cards: actionRes.cards,
      actions: actionRes.actions,
      sourceType: "live_database",
      model: "aqlan-action-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 4. فحص الاستعلام عن مريض (بحث جديد أو متابعة ضمن نفس الجلسة)
  const convPatientId =
    context.conversationPatientId ||
    (typeof context.currentPatientId === "number"
      ? context.currentPatientId
      : Number(context.currentPatientId) || null);

  const patientTerm = extractPatientIdentifier(trimmed);

  if (!patientTerm && isPatientFollowupQuery(trimmed) && (convPatientId || context.currentPatientName)) {
    // استخدام المريض السابق من سياق الجلسة
    let textSummary = "";
    let cards = undefined;
    let actions = undefined;

    if (convPatientId) {
      const patientResult = await executeAiTool(
        "get_patient_summary",
        { patientId: convPatientId },
        context,
      );
      textSummary = patientResult.textSummary;
      cards = patientResult.cards;
      actions = patientResult.actions;
    } else {
      const pName = context.currentPatientName || "المريض الحالي";
      textSummary = `👤 **متابعة المريض «${pName}»:**\nالاستفسار عن موعده أو حسابه تم تسجيله، وهو مرتبط بملف المريض الحالي.`;
    }

    return {
      answer: textSummary,
      intent: "patient_query",
      toolsUsed: ["get_patient_summary"],
      cards,
      actions,
      sourceType: "live_database",
      model: "aqlan-patient-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 4. استعلامات السيفالومتري الرقمي
  if (
    norm.includes("سيفالومتري") ||
    norm.includes("ceph") ||
    norm.includes("ستاينر") ||
    norm.includes("قياسات السيفالومتري") ||
    norm.includes("تحليل سيفالومتري")
  ) {
    /* لا سيفالو بلا مريضٍ معروف: «المريض رقم ١» الافتراضي ليس مريضًا، فالسؤال
       بلا سياقٍ يُسأل عن صاحب التحليل لا يُخترع له ملف. */
    if (!convPatientId) {
      return {
        answer: "📐 حدّد المريض أولًا: اكتب رقم ملفه أو اسمه الكامل، أو افتح ملفه من شاشة المرضى ثم اسأل داخل جلسته.",
        intent: "ceph_analysis",
        toolsUsed: [],
        sourceType: "internal_engine",
        model: "aqlan-ortho-engine",
        latencyMs: Date.now() - started,
        generatedAt: new Date().toISOString(),
      };
    }
    const cephResult = await executeAiTool(
      "get_cephalometric_summary",
      { patientId: convPatientId },
      context,
    );
    return {
      answer: cephResult.textSummary,
      intent: "ceph_analysis",
      toolsUsed: ["get_cephalometric_summary"],
      cards: cephResult.cards,
      actions: cephResult.actions,
      sourceType: "live_database",
      model: "aqlan-ortho-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 5. استعلامات التقويم والمتابعة
  if (
    norm.includes("متابعات التقويم") ||
    norm.includes("مرضى التقويم المتأخرين") ||
    norm.includes("من متأخر من مرضى التقويم") ||
    norm.includes("المتأخرين عن المتابعة") ||
    norm.includes("المتأخرين 30 يوم") ||
    norm.includes("متابعة التقويم") ||
    norm.includes("شدات اليوم")
  ) {
    const orthoResult = await executeAiTool("get_ortho_followups", {}, context);
    return {
      answer: orthoResult.textSummary,
      intent: "ortho_followups",
      toolsUsed: ["get_ortho_followups"],
      cards: orthoResult.cards,
      table: orthoResult.table,
      actions: orthoResult.actions,
      sourceType: "live_database",
      model: "aqlan-ortho-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  if (patientTerm) {
    const patientResult = await executeAiTool("search_patient", { term: patientTerm }, context);
    return {
      answer: patientResult.textSummary,
      intent: "patient_query",
      toolsUsed: ["search_patient"],
      cards: patientResult.cards,
      actions: patientResult.actions,
      sourceType: "live_database",
      model: "aqlan-patient-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 5. استعلامات المخزون والنواقص
  if (
    norm.includes("المخزون") ||
    norm.includes("المخزن") ||
    norm.includes("نواقص") ||
    norm.includes("المواد المنتهية") ||
    norm.includes("رصيد مادة") ||
    norm.includes("ليدوكايين") ||
    norm.includes("حد الطلب") ||
    norm.includes("مواد ناقصة") ||
    norm.includes("نفاد")
  ) {
    const invResult = await executeAiTool("get_inventory_summary", { onlyLowStock: true }, context);
    return {
      answer: invResult.textSummary,
      intent: "inventory_query",
      toolsUsed: ["get_inventory_summary"],
      cards: invResult.cards,
      table: invResult.table,
      actions: invResult.actions,
      sourceType: "live_database",
      model: "aqlan-inventory-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 6. استعلامات أوامر المعمل
  if (
    norm.includes("المعمل") ||
    norm.includes("معمل") ||
    norm.includes("المختبر") ||
    norm.includes("مختبر") ||
    norm.includes("معامل") ||
    norm.includes("حالات المعمل") ||
    norm.includes("لم تصل") ||
    norm.includes("طلبات المعمل") ||
    norm.includes("طلبيات مختبر") ||
    norm.includes("معمل التركيبات") ||
    norm.includes("معامل الأسنان")
  ) {
    const labResult = await executeAiTool("get_lab_cases", {}, context);
    return {
      answer: labResult.textSummary,
      intent: "lab_query",
      toolsUsed: ["get_lab_cases"],
      cards: labResult.cards,
      table: labResult.table,
      actions: labResult.actions,
      sourceType: "live_database",
      model: "aqlan-lab-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 7. استعلامات المواعيد وجدول اليوم
  if (
    norm.includes("مواعيد اليوم") ||
    norm.includes("موعد اليوم") ||
    norm.includes("جدول اليوم") ||
    norm.includes("جدول المواعيد") ||
    norm.includes("مواعيد العيادة") ||
    norm.includes("عندي مواعيد") ||
    norm.includes("حالات اليوم في جدول المواعيد") ||
    norm.includes("من هم المرضى الذين لديهم مواعيد اليوم") ||
    norm.includes("كم مريض متأخر عن الموعد") ||
    norm.includes("كم موعد اليوم") ||
    norm.includes("من عنده موعد")
  ) {
    const aptResult = await executeAiTool("get_today_appointments", {}, context);
    return {
      answer: aptResult.textSummary,
      intent: "today_appointments",
      toolsUsed: ["get_today_appointments"],
      cards: aptResult.cards,
      table: aptResult.table,
      actions: aptResult.actions,
      sourceType: "live_database",
      model: "aqlan-appointment-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 8. استعلامات الأطباء والخدمات والإحصائيات
  if (norm.includes("أطباء المركز") || norm.includes("من هم الأطباء") || norm.includes("دكاترة المركز")) {
    const docResult = await executeAiTool("get_doctors", {}, context);
    return {
      answer: docResult.textSummary,
      intent: "doctors_query",
      toolsUsed: ["get_doctors"],
      cards: docResult.cards,
      sourceType: "live_database",
      model: "aqlan-management-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  if (norm.includes("سعر") || norm.includes("أسعار") || norm.includes("بكم") || norm.includes("تكلفة") || norm.includes("دليل الخدمات")) {
    let kw = "";
    if (norm.includes("تقويم")) kw = "تقويم";
    else if (norm.includes("عصب") || norm.includes("جذور")) kw = "عصب";
    else if (norm.includes("حشوة") || norm.includes("حشو")) kw = "حشو";
    else if (norm.includes("زراع")) kw = "زراع";
    else if (norm.includes("خلع")) kw = "خلع";
    else if (norm.includes("تنظيف") || norm.includes("تبييض")) kw = "تنظيف";

    const svcResult = await executeAiTool("get_service_prices", { keyword: kw }, context);
    return {
      answer: svcResult.textSummary,
      intent: "services_query",
      toolsUsed: ["get_service_prices"],
      cards: svcResult.cards,
      table: svcResult.table,
      actions: svcResult.actions,
      sourceType: "live_database",
      model: "aqlan-management-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  if (norm.includes("إحصائيات المركز") || norm.includes("كم مريض بالمركز") || norm.includes("عدد المرضى")) {
    const statsResult = await executeAiTool("get_clinic_statistics", {}, context);
    return {
      answer: statsResult.textSummary,
      intent: "statistics_query",
      toolsUsed: ["get_clinic_statistics"],
      cards: statsResult.cards,
      sourceType: "live_database",
      model: "aqlan-management-engine",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 9. استعلامات المالية والتقارير المتقدمة (buildReport Bridge)
  const currency = extractCurrency(trimmed);
  const period = extractPeriodPreset(trimmed);
  const specialty = extractSpecialty(trimmed);

  if (
    norm.includes("دخل") ||
    norm.includes("إيرادات") ||
    norm.includes("تحصيل") ||
    norm.includes("حصلنا") ||
    norm.includes("صندوق") ||
    norm.includes("مديونية") ||
    norm.includes("مديونيات") ||
    norm.includes("أعمار الديون") ||
    norm.includes("تقرير") ||
    norm.includes("قارن") ||
    norm.includes("مستحقات الدكتور") ||
    norm.includes("عمولة") ||
    norm.includes("مصروفات")
  ) {
    if (norm.includes("أكثر") && (norm.includes("مديونية") || norm.includes("المرضى"))) {
      const recResult = await executeAiTool("get_patient_receivables", {}, context);
      return {
        answer: recResult.textSummary,
        intent: "patient_receivables",
        toolsUsed: ["get_patient_receivables"],
        cards: recResult.cards,
        table: recResult.table,
        actions: recResult.actions,
        sourceType: "live_database",
        model: "aqlan-report-bridge",
        latencyMs: Date.now() - started,
        generatedAt: new Date().toISOString(),
      };
    }

    let reportType: "daily" | "monthly" | "annual" | "debt" | "aging" | "specialty" | "doctor" | "collections" = "daily";
    let compare: "none" | "prev_period" | "prev_year" = "none";

    if (norm.includes("أعمار الديون") || norm.includes("أكثر من 90 يوم") || norm.includes("90 يوم")) {
      reportType = "aging";
    } else if (norm.includes("مديونية") || norm.includes("مديونيات")) {
      reportType = "debt";
    } else if (norm.includes("حصلنا") || norm.includes("تحصيل") || norm.includes("صندوق") || norm.includes("دخل")) {
      reportType = period === "today" ? "daily" : "collections";
    } else if (norm.includes("عمولة") || norm.includes("مستحقات الدكتور") || norm.includes("أطباء")) {
      reportType = "doctor";
    } else if (norm.includes("قارن") || norm.includes("مقارنة")) {
      reportType = "monthly";
      compare = "prev_period";
    } else if (period === "this_year" || period === "prev_year" || norm.includes("السنوي") || norm.includes("سنوي")) {
      reportType = "annual";
    } else if (period === "this_month" || period === "prev_month") {
      reportType = "monthly";
    }

    const reportResult = await executeAiTool(
      "generate_internal_report",
      {
        reportType,
        preset: period,
        currency,
        specialty,
        compare,
      },
      context,
    );

    let intentName = "finance_report";
    if (reportType === "debt") {
      intentName = "debt_report";
    } else if (reportType === "aging") {
      intentName = "debt_aging";
    }

    return {
      answer: reportResult.textSummary,
      intent: intentName,
      toolsUsed: ["generate_internal_report"],
      cards: reportResult.cards,
      table: reportResult.table,
      actions: reportResult.actions,
      warnings: reportResult.warnings,
      sourceType: "live_database",
      model: "aqlan-report-bridge",
      latencyMs: Date.now() - started,
      generatedAt: new Date().toISOString(),
    };
  }

  // 10. الاستفسارات السريرية والطبية وطوارئ الأسنان والأدوية
  const clinicalResult = await generateDentalExpertReply(
    conversationHistory.length > 0
      ? conversationHistory.map((m) => ({ role: m.role, content: m.content }))
      : [{ role: "user", content: trimmed }],
    {
      userRole: context.role,
      username: context.username,
      doctorPartyId: context.doctorPartyId,
      canViewAllPatients: context.canViewAllPatients,
      canViewFinancials: context.canViewClinicFinance,
    },
  );

  const clinicalMap: Record<string, string> = {
    pharmacology: "clinical_general",
    anesthesia: "clinical_general",
    endo_emergency: "clinical_general",
    general_clinical: "clinical_general",
    post_op: "clinical_general",
  };
  const mappedIntent = clinicalMap[clinicalResult.category] || clinicalResult.category;

  return {
    answer: clinicalResult.reply,
    intent: mappedIntent,
    toolsUsed: ["dental_clinical_expert"],
    sourceType: "internal_engine",
    model: clinicalResult.model,
    latencyMs: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}
