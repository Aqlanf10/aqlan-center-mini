/**
 * (P2-11 — قرار المالك) نطاق المزوّد الخارجي للذكاء الاصطناعي: **Claude للمهام الإدارية فقط**.
 *
 * المساعد يعمل محليًّا أولًا (محرك الاستعلامات والأدوات داخل المركز). والمزوّد الخارجي
 * لا يُستشار إلا في حالتين، ولكلٍّ حدّها:
 *
 * - **إدارية** (صياغة رسالة أو إعلان، تنظيم العمل والطاقم — سؤالٌ بلا دلالةٍ سريرية لم يجد
 *   له المحرك المحلي جوابًا من بيانات المركز): تُرسل رسالة
 *   المستخدم الأخيرة وحدها بعد إزالة الهوية، مع تعليماتٍ إدارية — لا سجلّ محادثةٍ قد يحمل
 *   نصًّا سريريًّا سابقًا، ولا بيانات من قاعدة المركز.
 * - **سريرية** (دواء، تخدير، طوارئ، تقويم، ما بعد الجراحة، تحليل السيفالو): **لا تخرج إلا
 *   إذا فعّل المدير `ai.clinical_external` صراحةً** — والافتراضي معطَّل. فالنص السريري يبقى
 *   داخل المركز، والرد من المحرك المحلي.
 */

import { normalizeName } from "./duplicates";

/** أصناف الاستشارة السريرية — لا تخرج إلى المزوّد إلا بتفعيلٍ صريح. */
export const CLINICAL_EXTERNAL_INTENTS: ReadonlySet<string> = new Set([
  "pharmacology",
  "anesthesia",
  "endo_emergency",
  "orthodontics",
  "post_op",
  "general_clinical",
  "clinical_general",
]);

/**
 * الصنف الجامع في المحرك المحلي: ما لم يطابق صنفًا بعينه ينتهي إليه — ومنه أسئلةٌ إدارية
 * بحتة («اكتب إعلانًا عن إجازة العيد»). فيُفرز بنصّه: بلا دلالةٍ سريرية ⇒ إداري.
 */
const CATCH_ALL_INTENTS: ReadonlySet<string> = new Set(["general_clinical", "clinical_general"]);

/**
 * دلالات سريرية في النص — فرزٌ محافظ: كلمةٌ واحدة منها تُبقي النص داخل المركز.
 * الخطأ هنا في اتجاهٍ واحد مقبول: سؤالٌ إداري فيه «ألم» يُجاب محليًّا، لا العكس.
 */
const CLINICAL_SIGNALS = [
  // كلماتٌ كاملة الدلالة — لا مقاطع قصيرة تقع داخل كلماتٍ إدارية («لب» في «طلب»،
  // «تاج» في «نحتاج»، «حمل» في «حملة»، «السكر» في «السكرتارية»، «فك» في «فكرة»).
  "دواء", "أدوية", "ادوية", "جرعة", "جرعه", "مضاد", "حيوي", "مسكن", "مسكّن", "ملغ",
  "ألم", "وجع", "التهاب", "خراج", "صديد", "نزيف", "تورم", "ورم", "حمى", "حرارة",
  "تخدير", "بنج", "حساسية", "حامل", "سكري", "ضغط الدم", "القلب", "الكلى", "الكبد",
  "عصب", "خلع", "قلع", "زرع", "زراعة", "تقويم", "سيفالو", "أشعة", "اشعة", "بانوراما",
  "تشخيص", "حشوة", "حشو", "تيجان", "جسر", "لثة", "لثه", "جراحة", "خياطة", "غرز",
  "تسوس", "الفك", "إطباق", "اطباق", "علاج", "وصفة", "روشتة",
  "قرحة", "قرح", "فموي", "فموية", "كسر", "السن", "سنه", "ضرس", "اضراس", "أضراس", "ناب",
  "حالة", "مصاب", "مصابة", "مريض", "مريضة", "المريض", "توصيات", "أعراض", "اعراض", "نزف",
  "amoxicillin", "ibuprofen", "paracetamol", "antibiotic", "dose", "infection",
];

export function hasClinicalSignal(text: string): boolean {
  const normalized = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  return CLINICAL_SIGNALS.some((signal) => normalized.includes(signal.toLowerCase()));
}

/**
 * طلبٌ إداري صريح: صياغةٌ أو تنظيم — لا يكفي غياب الدلالة السريرية وحده، فسؤالٌ عام
 * بلا طلبٍ إداري («ما رأيك؟») يبقى محليًّا.
 */
const ADMIN_SIGNALS = [
  "اكتب", "أكتب", "صغ", "صياغة", "رسالة", "رساله", "إعلان", "اعلان", "تعميم", "منشور", "خطاب",
  "جدول", "دوام", "مناوبة", "مناوبات", "موظف", "الموظفين", "الطاقم", "إجازة", "اجازة", "عطلة", "العيد",
  "تذكير", "واتساب", "شكر", "اعتذار", "ترحيب", "تهنئة", "تسويق", "حملة", "لخص", "لخّص", "ترجم", "نظم", "رتب",
];

export function hasAdministrativeSignal(text: string): boolean {
  const normalized = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  return ADMIN_SIGNALS.some((signal) => normalized.includes(signal.toLowerCase()));
}

/** يخرج إداريًّا: طلبٌ إداري صريح **و**لا دلالة سريرية فيه. */
export function isAdministrativeRequest(text: string): boolean {
  return hasAdministrativeSignal(text) && !hasClinicalSignal(text);
}

/**
 * أسماء المسجّلين في المركز (مرضى، جهات، طاقم) تُقنَّع قبل الخروج: كل كلمةٍ تطابق
 * كلمةً من أسمائهم — ولو بحرف جرٍّ أو عطفٍ ملتصق (لأحمد، وعلي، بسعيد) — تصير «[اسم]».
 * والمقارنة بعد التطبيع (الهمزات، التاء المربوطة، الألف المقصورة).
 */
export function redactPersonNames(text: string, nameTokens: ReadonlySet<string>): string {
  if (nameTokens.size === 0) return text;
  return text.replace(/[\p{L}\p{M}]+/gu, (word) => {
    const normalized = normalizeName(word);
    if (normalized.length > 1 && nameTokens.has(normalized)) return "[اسم]";
    // سوابق ملتصقة قد تتراكب: «ولسعيد»، «فبأحمد»، «وللطبيب».
    const stripped = normalized.replace(/^(?:و|ف)?(?:ل|ب|ك)?(?:ال)?/, "");
    if (stripped.length > 1 && nameTokens.has(stripped)) return "[اسم]";
    return word;
  });
}

export type ExternalConsultPlan =
  | { kind: "none" }
  | { kind: "administrative" }
  | { kind: "clinical" }
  /** سؤالٌ سريري والمزوّد مضبوط إداريًّا — يُقال للمستخدم لا يمرّ صامتًا. */
  | { kind: "clinical_blocked"; reason: "scope" | "identity" };

/**
 * هل يُستشار المزوّد الخارجي، وبأيّ حدّ؟ دالة خالصة — القرار كله هنا ويُختبر بجدول.
 * الأصناف المبنية على بيانات المركز (مواعيد اليوم، المرضى، الإحصاءات، دليل البرنامج،
 * الإجراءات) تبقى محليّة دائمًا: ردّها من القاعدة، والمزوّد لا يعرفها فيخترع.
 *
 * والإداري يأتي من الصنف الجامع — أو من رفض الحارس السريري المحلي لحسابٍ بلا هوية
 * سريرية (الاستقبال والمدير غير المربوط): طلبهم الإداري لم يطابق شيئًا فانتهى إلى الحارس.
 */
export function externalConsultPlan(input: {
  intent: string;
  /** رسالة المستخدم الأخيرة — لفرز الصنف الجامع. */
  message: string;
  hasKey: boolean;
  /** الإعداد `ai.clinical_external`. */
  clinicalExternalAllowed: boolean;
  /** هوية سريرية ثابتة (طبيب مربوط بجهته). */
  clinicalIdentity: boolean;
}): ExternalConsultPlan {
  if (!input.hasKey) return { kind: "none" };
  const catchAll = CATCH_ALL_INTENTS.has(input.intent) || input.intent === "clinical_scope_rejection";
  if (catchAll && isAdministrativeRequest(input.message)) return { kind: "administrative" };
  if (!CLINICAL_EXTERNAL_INTENTS.has(input.intent)) return { kind: "none" };
  if (!input.clinicalExternalAllowed) return { kind: "clinical_blocked", reason: "scope" };
  if (!input.clinicalIdentity) return { kind: "clinical_blocked", reason: "identity" };
  return { kind: "clinical" };
}

/** تعليمات المزوّد في المهام الإدارية. */
export const ADMIN_ASSISTANT_SYSTEM_PROMPT = [
  "أنت مساعدٌ إداري لمركز أسنان في تعز، اليمن. تساعد الإدارة والاستقبال في تشغيل العيادة:",
  "تنظيم المواعيد والطاقم، تقليل الزحمة وقائمة الانتظار، صياغة الرسائل والإعلانات للمرضى بلغةٍ مهذبة، ومتابعة أعمال المختبر.",
  "لا تقدّم أي رأي سريري أو دوائي أو تشخيصي — إن جاءك سؤالٌ سريري فقل إنه خارج مهامك ويُسأل عنه الطبيب.",
  "لا تخترع خطوات لاستعمال برنامج المركز ولا أرقامًا عن المركز لم تُعطَ لك.",
  "أجب بالعربية، بإيجاز ووضوح.",
].join("\n");

export const CLINICAL_SCOPE_NOTICE =
  "المزوّد الخارجي مضبوط للمهام الإدارية فقط — لم يُرسل نصٌّ سريري خارج المركز، والرد أعلاه من المحرك المحلي. (يغيّره المدير من الإعدادات: «إرسال الأسئلة السريرية للمزوّد الخارجي».)";
