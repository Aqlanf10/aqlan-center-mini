import "server-only";
import { getPool } from "./db";
import { readStaffEntryMode } from "./legacy-staff-schema.mjs";

/**
 * وضع الدخول لهذا النشر — قراءة كتالوج فقط، بلا تهيئة ولا قفل.
 *
 * "legacy": قاعدة بلا أي أثر لسلطة الهوية الموحّدة؛ يبقى الدخول القديم كما هو.
 * "canonical": أي أثر (جداول، دوال، مشغّلات، أعمدة) — لا يعمل إلا المُصدِر الموحّد،
 * وكل حالة جزئية أو محجورة أو منحرفة ترفض هناك. ليس رجوعًا لكل طلب: فشل القراءة
 * يرمي، والمسار يرد خطأ خادم لا الدخول القديم.
 */
export async function currentStaffEntryMode(): Promise<"legacy" | "canonical"> {
  return readStaffEntryMode(getPool());
}
