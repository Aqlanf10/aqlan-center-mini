import { clientIpFromForwardedFor } from "./net";

/**
 * (P3-5) مصدر الطلب الجاري لسطر التدقيق: عنوان الجهاز والمتصفح.
 *
 * العنوان يُقرأ من `x-forwarded-for` **خلف وسيطٍ موثوق وحده** (`TRUST_PROXY=true`) —
 * آخر قيمة في السلسلة، وهي ما أضافه الوسيط نفسه؛ بلا وسيط الترويسة يكتبها العميل فلا
 * تُسجَّل شهادةً مزوّرة. وخارج سياق طلب (سكربت، مهمة خلفية، اختبار) يعود فارغًا بلا خطأ:
 * التدقيق لا يسقط لأن المصدر مجهول.
 */
export async function currentAuditSource(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const { headers } = await import("next/headers");
    const list = await headers();
    const ip = (process.env.TRUST_PROXY ?? "").trim().toLowerCase() === "true"
      ? clientIpFromForwardedFor(list.get("x-forwarded-for"))
      : null;
    const agent = list.get("user-agent");
    return { ip, userAgent: agent ? agent.replace(/[\r\n]/g, " ").slice(0, 300) : null };
  } catch {
    return { ip: null, userAgent: null };
  }
}
