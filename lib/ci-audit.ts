/**
 * بوابة تدقيق الاعتماديات في CI — قرارها من تقرير `npm audit --json`.
 *
 * لماذا تحتاج قرارات مكتوبة لا أمر `npm audit` وحده: سجل npm أوقف endpoint
 * التدقيق القديم (audits/quick) فصار يردّ ٤٠٠ للعملاء القدامى، ثم بدأ يردّ ٥٠٣
 * لخدمة الإعلانات بالجملة نفسها من عناوين خوادم CI المزدحمة — عطلُ خدمةٍ متقطع
 * في طرف npm لا علاقة له باعتمادياتنا. أمرٌ واحد لا يفرّق بين «ثغرة مؤكدة» و
 * «السجل لا يستجيب»، فيُفشل بناء العيادة لانقطاع طرفٍ ثالث. هنا يُفترق الأمران:
 * الثغرة تُفشل البناء فورًا، وانقطاع الخدمة «غير مكتمل» يُعاد محاولةً ثم يُمرَّر
 * بتحذيرٍ صريح — الأمان حاضرٌ، والتعطيل غائب.
 */

/** نتيجة البوابة: خضراء، حمراء، أو غير مكتملة لعطلٍ في خدمة السجل. */
export type AuditOutcome = "pass" | "fail" | "unavailable";

export interface AuditVulnerabilityCounts {
  info?: number;
  low?: number;
  moderate?: number;
  high?: number;
  critical?: number;
}

export interface NpmAuditReport {
  metadata?: {
    vulnerabilities?: AuditVulnerabilityCounts;
  };
  error?: unknown;
}

function extractCounts(report: unknown): AuditVulnerabilityCounts | null {
  if (typeof report !== "object" || report === null) return null;
  const metadata = (report as NpmAuditReport).metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const counts = metadata.vulnerabilities;
  if (typeof counts !== "object" || counts === null) return null;
  return counts;
}

/**
 * قرار البوابة من تقرير التدقيق:
 * - `pass`: اكتمل التدقيق ولا ثغرة تبلغ عتبة الفشل (moderate فأعلى — عتبة
 *   `--audit-level=moderate` نفسها؛ الثغرات المنخفضة لا توقف البناء).
 * - `fail`: اكتمل التدقيق وفيه ثغرةٌ تبلغ العتبة — تفشل البناء.
 * - `unavailable`: التقرير بلا إحصاءات ثغرات أصلًا (عطل سجل npm أو خرجٌ غير
 *   قابل للتحليل) — ليس ثغرة، والقرار في يد العدّاء: محاولةٌ ثم تحذير.
 */
export function decideAuditOutcome(report: unknown): AuditOutcome {
  const counts = extractCounts(report);
  if (counts === null) return "unavailable";
  const blocking =
    (counts.moderate ?? 0) + (counts.high ?? 0) + (counts.critical ?? 0);
  return blocking > 0 ? "fail" : "pass";
}

/** ملخّص الثغرات الحاجبة بصيغةٍ للعرض في سجل CI عند فشل البوابة. */
export function describeBlockingVulnerabilities(report: unknown): string {
  const counts = extractCounts(report);
  if (counts === null) return "لا إحصاءات في التقرير";
  const parts: string[] = [];
  if ((counts.moderate ?? 0) > 0) parts.push(`moderate: ${counts.moderate}`);
  if ((counts.high ?? 0) > 0) parts.push(`high: ${counts.high}`);
  if ((counts.critical ?? 0) > 0) parts.push(`critical: ${counts.critical}`);
  return parts.length > 0 ? parts.join("، ") : "لا ثغرات حاجبة";
}
