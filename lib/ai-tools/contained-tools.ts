/**
 * احتواء سلامة مالية (CORE-SAFETY) لأدوات المساعد ذات الأثر المالي.
 *
 * أداة «تسجيل سند قبض» في المساعد كانت تكتب السند بلا مفتاح إعادة ثابت وبلا مراجعة السندات
 * المشابهة التي يمر بها كل باب تحصيل بشري آخر، واستهلاك رمز التأكيد يسبق الكتابة فلا يستعيد
 * إعادةُ الرمز سنده. لذلك سُحب تنفيذها: تُرفض قبل إصدار أي عرض تأكيد وقبل استهلاك أي رمز —
 * بما فيها الرموز الموقّعة الصادرة سابقًا — ويُوجَّه الموظف إلى شاشة التحصيل المعتمدة المحمية.
 * لا صلاحية جديدة ولا إعداد ولا علم تشغيل: الأدوات الأخرى وصلاحيات المستخدمين كما هي.
 */
import type { ToolExecutionResult } from "./types";

/** الأسماء القانونية للأدوات المحتواة (الأسماء البديلة تُحلّ إليها في السياسة المركزية). */
export const CONTAINED_ASSISTANT_TOOLS: ReadonlySet<string> = new Set(["record_patient_payment"]);

export function isContainedAssistantTool(canonicalName: string): boolean {
  return CONTAINED_ASSISTANT_TOOLS.has(canonicalName);
}

const MESSAGE =
  "⛔ تسجيل سندات القبض عبر المساعد الذكي موقوف حفاظًا على سلامة الصندوق. لم يُسجَّل أي سند ولم يُستهلك أي تأكيد. سجّل الدفعة من شاشة التحصيل المعتمدة — فهي تحفظ مفتاح الإعادة وتعرض السندات المشابهة قبل القبض.";

/** نتيجة الرفض الموحّدة للأداة المحتواة: لا عرض تأكيد ولا تنفيذ، ورابط لشاشة التحصيل المحمية. */
export function containedToolRefusal(): ToolExecutionResult {
  return {
    success: false,
    textSummary: MESSAGE,
    message: MESSAGE,
    warnings: ["أداة مالية محتواة: التنفيذ عبر المساعد موقوف"],
    actions: [{ label: "فتح شاشة التحصيل", href: "/finance", actionType: "navigate" }],
  };
}
