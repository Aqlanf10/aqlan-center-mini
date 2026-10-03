/**
 * بوابة تدقيق الاعتماديات في CI — قرارها من تقرير `npm audit --json`.
 *
 * لماذا تحتاج قرارات مكتوبة لا أمر `npm audit` وحده: سجل npm أوقف endpoint
 * التدقيق القديم (audits/quick) فصار يردّ ٤٠٠ للعملاء القدامى، ثم بدأ يردّ ٥٠٣
 * لخدمة الإعلانات بالجملة نفسها من عناوين خوادم CI المزدحمة — عطلُ خدمةٍ متقطع
 * في طرف npm لا يثبت سلامة اعتمادياتنا ولا إصابتها. نفرّق بين «ثغرة مؤكدة» و
 * «تدقيق غير مكتمل»: الثغرة تُفشل البناء فورًا، والتقرير الناقص يُعاد محاولةً،
 * ثم يُفشل البوابة إن لم يكتمل. لا تُعلَن السلامة بلا تقرير صالح مكتمل.
 */

/** نتيجة البوابة: خضراء، حمراء، أو غير مكتملة لعطلٍ في خدمة السجل. */
export type AuditOutcome = "pass" | "fail" | "unavailable";

export interface AuditVulnerabilityCounts {
  info: number;
  low: number;
  moderate: number;
  high: number;
  critical: number;
}

const AUDIT_SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
const BLOCKING_SEVERITIES = ["moderate", "high", "critical"] as const;

export interface NpmAuditReport {
  metadata?: {
    vulnerabilities?: AuditVulnerabilityCounts;
  };
  error?: unknown;
}

function extractCounts(report: unknown): AuditVulnerabilityCounts | null {
  if (typeof report !== "object" || report === null || Array.isArray(report)) return null;
  const metadata = (report as NpmAuditReport).metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const counts = metadata.vulnerabilities;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) return null;
  for (const severity of AUDIT_SEVERITIES) {
    const count = counts[severity];
    if (
      !Object.hasOwn(counts, severity) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) return null;
  }
  return counts;
}

/**
 * قرار البوابة من تقرير التدقيق:
 * - `pass`: اكتمل التدقيق ولا ثغرة تبلغ عتبة الفشل (moderate فأعلى — عتبة
 *   `--audit-level=moderate` نفسها؛ الثغرات المنخفضة لا توقف البناء).
 * - `fail`: اكتمل التدقيق وفيه ثغرةٌ تبلغ العتبة — تفشل البناء.
 * - `unavailable`: التقرير ناقص أو إحصاءاته غير صالحة (عطل سجل npm أو خرجٌ غير
 *   قابل للتحليل) — لا يثبت السلامة؛ يعيد العدّاء المحاولة ثم يفشل البوابة.
 */
export function decideAuditOutcome(report: unknown): AuditOutcome {
  const counts = extractCounts(report);
  if (counts === null) return "unavailable";
  if (BLOCKING_SEVERITIES.some((severity) => counts[severity] > 0)) return "fail";
  // A complete-looking zero summary cannot override an explicit audit error.
  if (Object.hasOwn(report as NpmAuditReport, "error")) return "unavailable";
  return "pass";
}

/** ملخّص الثغرات الحاجبة بصيغةٍ للعرض في سجل CI عند فشل البوابة. */
export function describeBlockingVulnerabilities(report: unknown): string {
  const counts = extractCounts(report);
  if (counts === null) return "لا إحصاءات في التقرير";
  const parts: string[] = [];
  if (counts.moderate > 0) parts.push(`moderate: ${counts.moderate}`);
  if (counts.high > 0) parts.push(`high: ${counts.high}`);
  if (counts.critical > 0) parts.push(`critical: ${counts.critical}`);
  return parts.length > 0 ? parts.join("، ") : "لا ثغرات حاجبة";
}
