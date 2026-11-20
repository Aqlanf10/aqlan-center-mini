/**
 * طبقة الخصوصية وإلغاء تحديد الهوية السريرية (Clinical Privacy & De-Identification)
 *
 * تنفيذاً للمادة 202 من الدستور الطبي للمركز:
 * لا تخرج أي معلومة تعرّف بالهوية الصريحة لأي مريض (الاسم، الهاتف، رقم الملف السكني،
 * العنوان، البريد، الهوية) إلى أي مزوّد خارجي إطلاقاً.
 */

// Keep the existing phone grammar shared with the file-token overlap check.
const PHONE_PATTERN = /(?:\+?967[\s-]?)?0?[7138]\d{1}[\s-]?\d{3}[\s-]?\d{3,4}\b/g;

function maskFileReferences(text: string, pattern: RegExp, replacement: string): string {
  const phones = [...text.matchAll(PHONE_PATTERN)];
  return text.replace(pattern, (reference: string, offset: number) => {
    const end = offset + reference.length;
    // Do not split a grouped phone already covered by the existing phone mask.
    // E.g. A-71-234-567 must leave 71-234-567 intact for that pass.
    const splitsPhone = phones.some(phone => phone.index < end && phone.index + phone[0].length > end);
    return splitsPhone ? reference : replacement;
  });
}

/**
 * تنظيف وتعقيم النصوص والسياق السريري الموجه لأي مزود خارجي (LLM)
 * لضمان عدم تسريب أي بيانات تعريفية شخصية (PII).
 */
export function deIdentifyClinicalContext(
  text: string,
  knownNames: string[] = [],
): string {
  if (!text) return "";

  let cleaned = text;

  // 1. تقنيع البريد الإلكتروني
  cleaned = cleaned.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[بريد محمي]");

  // 2. Mask every selectable A–Z prefix, including historical prefixes.
  // Match full file tokens before generic phone/number masking can split them.
  // Canonical codes keep their hyphen; retain legacy P123 and explicitly labelled
  // no-hyphen forms without newly treating clinical terms such as B12 as file IDs.
  cleaned = maskFileReferences(cleaned, /\b(?:[A-Za-z]-\d+|[Pp]\d+)\b/g, "[ملف محمي]");
  cleaned = maskFileReferences(cleaned, /(?:ملف|رقم\s+الملف)\s*[:#]?\s*[`'"]?[A-Za-z]?-?\d+[`'"]?/gi, "ملف [محمي]");

  // 3. تقنيع أرقام الهواتف (اليمنية والدولية والأرقام الطويلة 7-15 خانة)
  cleaned = cleaned.replace(PHONE_PATTERN, "[هاتف محمي] •••");
  cleaned = cleaned.replace(/\b\d{7,15}\b/g, "[رقم محمي] •••");
  cleaned = cleaned.replace(/[\u0660-\u0669]{7,15}/g, "[رقم محمي] •••");

  // 4. تقنيع الأسماء المعروفة الممررة صراحة
  for (const name of knownNames) {
    if (name && name.trim().length >= 2) {
      const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const reg = new RegExp(escaped, "gi");
      cleaned = cleaned.replace(reg, "[المريض]");
    }
  }

  // 5. تقنيع أنماط الأسماء الصريحة التي تبدأ بـ "المريض فلان" أو "المريضة فلانة"
  cleaned = cleaned.replace(
    /(?:المريض|المريضة|مريض|مريضة)\s+([^\s؟?,،.:!\[\]]+(?:\s+[^\s؟?,،.:!\[\]]+){1,3})/gi,
    (match, capturedName) => {
      if (capturedName.includes("[") || capturedName.includes("]")) {
        return match;
      }
      // تجنب استبدال الكلمات السريرية العامة مثل "حساسية بنسلين" أو "مرض السكري"
      const lower = capturedName.trim().toLowerCase();
      if (
        lower.includes("سكري") ||
        lower.includes("ضغط") ||
        lower.includes("قلب") ||
        lower.includes("حساسية") ||
        lower.includes("نزيف") ||
        lower.includes("عصب") ||
        lower.includes("تقويم") ||
        lower.includes("طفل") ||
        lower.includes("حامل")
      ) {
        return match;
      }
      return "[المريض]";
    },
  );

  // 6. تقنيع العناوين المفصلة الصريحة
  cleaned = cleaned.replace(/(?:العنوان|عنوانه|عنوانها)\s*:\s*[^\n,،.]+/gi, "العنوان: [عنوان محمي]");

  return cleaned;
}
