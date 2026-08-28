import { cookies } from "next/headers";
import { SESSION_COOKIE, readSessionToken, type SessionPayload } from "./auth";

/**
 * الجلسة الموثوقة — بعد التحقق من التوقيع.
 *
 * `middleware` يفحص وجود الكوكي فقط لأنه يعمل على Edge بلا `node:crypto`. فلو اكتُفي
 * به لكان بإمكان أي زائر أن يضع كوكي بأي محتوى ويمرّ. هذه الدالة هي التحقق الحقيقي،
 * وتُستدعى في كل مسار API يقرأ أو يكتب بيانات مرضى.
 */
export async function requireSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return readSessionToken(store.get(SESSION_COOKIE)?.value);
}
