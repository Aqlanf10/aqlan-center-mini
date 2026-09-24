/**
 * (P1-1) مفتاح إعادة (Idempotency-Key) لطلبات المال من المتصفح.
 *
 * الخادم يقبل `^[A-Za-z0-9._:-]{8,128}$` (app/api/payments). و`crypto.randomUUID`
 * متاح في السياقات الآمنة فقط (HTTPS/localhost) — والعيادة قد تفتح النظام على
 * شبكتها المحلية بعنوان IP بلا HTTPS؛ فالاحتياط `crypto.getRandomValues` المتاح في
 * كل سياق. لا Math.random: مفتاحٌ يتكرّر بين جهازين يدمج سندين مختلفين.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function newIdempotencyKey(prefix = "pay"): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return `${prefix}:${cryptoApi.randomUUID()}`;
    } catch {
      // سياقٌ غير آمن — نكمل إلى getRandomValues.
    }
  }
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("مولّد الأرقام العشوائية الآمن غير متاح في هذا المتصفح.");
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return `${prefix}:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
