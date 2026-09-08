import path from "node:path";

/**
 * تحقق مسارات المستندات الآمنة (P1.13) — لا بادئة نصية وحدها أبدًا.
 *
 * `target.startsWith(base)` — النمط القائم في restore-full.mjs القديم — يُخدع
 * بـ`/data-evil` أمام `/data`: نفس البادئة، مسارٌ آخر تمامًا. الحارس هنا
 * يحلّ المسار في نظام الملفات ويقارن المكوّن لا البادئات:
 *
 * القواعد (كلها إلزامية):
 *  ١) المسار النسبي نصٌّ غير فارغ.
 *  ٢) يُرفض المطلق (يبدأ بـ/ أو محرف قرص Windows أو UNC).
 *  ٣) يُرفض أي مكوّن `..` (بالفواصل الموحَّدة بعد التطبيع).
 *  ٤) يُرفض null byte (حرف النهاية في C-strings يقطع الفحص بعده).
 *  ٥) التطبيع: فواصل موحَّدة، لا مكررات نقطية زائدة، ثم join مع الأساس.
 *  ٦) الناتج المحلول يجب أن يظل داخل الأساس — بفك المكوّنات (path.relative)
 *     لا ببادئة نصية.
 *  ٧) تُرفض الوجهات المكررة (duplicate destinations) في دفعة واحدة.
 */

export interface SafePathResult {
  ok: boolean;
  /** المسار المطلق المحلول — صالح فقط حين ok=true. */
  resolved: string | null;
  /** سبب الرفض مقروءًا — null حين ok=true. */
  reason: string | null;
}

const NULL_BYTE = "\0";

export function validateRelativePath(relativePath: string): SafePathResult {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return { ok: false, resolved: null, reason: "مسار فارغ" };
  }
  if (relativePath.includes(NULL_BYTE)) {
    return { ok: false, resolved: null, reason: "null byte في المسار" };
  }
  if (path.isAbsolute(relativePath)) {
    return { ok: false, resolved: null, reason: `مسار مطلق مرفوض: ${relativePath}` };
  }
  // محرف قرص Windows (C:\) أو UNC (\\server) حتى لو جاء على لينكس
  if (/^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith("\\\\")) {
    return { ok: false, resolved: null, reason: `مسار مطلق (نمط Windows) مرفوض: ${relativePath}` };
  }

  // توحيد الفواصل ثم فك المكوّنات: كل `.` تُحذف (دليل حالي بلا معنى)، وكل `..` جريمة.
  const unified = relativePath.replace(/\\/g, "/");
  const parts = unified.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) {
    return { ok: false, resolved: null, reason: "مسار بلا مكوّنات" };
  }
  for (const part of parts) {
    if (part === "..") {
      return { ok: false, resolved: null, reason: `مسار يحاول الخروج للأعلى (..): ${relativePath}` };
    }
    if (part.includes(NULL_BYTE)) {
      return { ok: false, resolved: null, reason: "null byte في مكوّن المسار" };
    }
  }

  const normalized = parts.join("/");
  return { ok: true, resolved: normalized, reason: null };
}

/**
 * يحلّ مسارًا نسبيًا داخل أساس معين ويتحقق أن الناتج يبقى داخله.
 * يعيد المسار المطلق الآمن أو سبب الرفض — بلا startsWith أبدًا.
 */
export function resolveInsideBase(base: string, relativePath: string): SafePathResult {
  const validated = validateRelativePath(relativePath);
  if (!validated.ok || !validated.resolved) return validated;

  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, validated.resolved);
  const relative = path.relative(resolvedBase, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { ok: false, resolved: null, reason: `المسار المحلول يخرج من الأساس: ${relativePath}` };
  }
  if (relative.length === 0) {
    return { ok: false, resolved: null, reason: "الوجهة هي الأساس نفسه (دليل لا ملف)" };
  }
  return { ok: true, resolved: target, reason: null };
}

/**
 * التحقق من دفعة وجهات كاملة: كل مسار آمن، ولا تكرار في الوجهات النهائية
 * (مكرران مختلفان نصيًّا قد يتحلان إلى نفس الملف — يكتب أحدهما فوق الآخر).
 */
export function validateDestinationBatch(
  base: string,
  relativePaths: string[],
): { ok: true; resolved: string[] } | { ok: false; reason: string; index: number } {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (let index = 0; index < relativePaths.length; index++) {
    const check = resolveInsideBase(base, relativePaths[index]);
    if (!check.ok || !check.resolved) {
      return { ok: false, reason: check.reason ?? "مسار غير آمن", index };
    }
    if (seen.has(check.resolved)) {
      return {
        ok: false,
        reason: `وجهة مكررة بعد الحل: ${relativePaths[index]} → ${check.resolved}`,
        index,
      };
    }
    seen.add(check.resolved);
    resolved.push(check.resolved);
  }
  return { ok: true, resolved };
}

/**
 * أسماء تشارك بادئة الأساس — الحالة التي يخدع فيها startsWith:
 * `resolveInsideBase('/data', 'x/../../etc/passwd')` ونحوها مرفوضة، وكذلك
 * أساس مثل `/data` مع مسار `/data-evil/x` (مطلق يُرفض من الأساس).
 */
export function isSameOrInside(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}
