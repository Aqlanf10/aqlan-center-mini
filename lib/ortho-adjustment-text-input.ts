/** Raw HTTP text admission for new writes. Legacy journal matching uses the
 * unchanged normalized payload and is resolved before this refusal is applied. */
export function adjustmentTextAdmissionError(source: Record<string, unknown>): string | null {
  for (const [field, limit] of [["upperWire",40],["lowerWire",40],["elasticNote",120],["done",400],["note",300]] as const) {
    if (!Object.hasOwn(source, field) || source[field] === null) continue;
    const value = source[field];
    if (typeof value !== "string") return "حقول وصف الشدّة يجب أن تكون نصًا أو فارغة؛ لم تُسجّل جلسة جديدة.";
    if (value.trim().length > limit) return `الحقل ${field} يتجاوز ${limit} حرفًا؛ اختصر النص قبل تسجيل جلسة جديدة.`;
  }
  return null;
}
