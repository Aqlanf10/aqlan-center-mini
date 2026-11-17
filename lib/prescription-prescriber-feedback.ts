/** Non-sensitive diagnostics only; these messages never grant clinical authority. */
export const PRESCRIBER_UNAVAILABLE_MESSAGES = {
  session_unavailable: "تعذّر التحقق من صلاحية الحساب الحالي. سجّل الدخول من جديد، ثم أعد المحاولة.",
  role_ineligible: "دور الحساب الحالي غير مخوّل بإصدار الوصفات الطبية. استخدم حساب طبيب مخوّل.",
  doctor_link_missing: "حسابك غير مرتبط بجهة طبيب. اطلب من مسؤول المستخدمين مراجعة الربط السريري للحساب؛ لا يكفي دور المدير وحده لإصدار وصفة.",
  doctor_identity_invalid: "جهة الطبيب المرتبطة بالحساب غير صالحة. اطلب من مسؤول المستخدمين مراجعة الربط السريري.",
  doctor_identity_inactive: "جهة الطبيب المرتبطة بالحساب غير نشطة. اطلب من مسؤول المستخدمين مراجعة حالتها.",
  doctor_name_missing: "اسم جهة الطبيب المرتبطة بالحساب غير مكتمل. اطلب من مسؤول المستخدمين استكمال بياناتها.",
} as const;
export type PrescriberUnavailableReason = keyof typeof PRESCRIBER_UNAVAILABLE_MESSAGES;
export function prescriberUnavailableMessage(reason: unknown): string | null {
  return typeof reason === "string" && Object.hasOwn(PRESCRIBER_UNAVAILABLE_MESSAGES, reason)
    ? PRESCRIBER_UNAVAILABLE_MESSAGES[reason as PrescriberUnavailableReason] : null;
}
