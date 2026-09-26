/**
 * (DAY1) قراءة سعر الخدمة بالسعودي/الدولار من طلب الدليل: غيابه يُبقي، والفارغ يمسح
 * (فيعود التحويل بسعر الصرف)، والمبلغ يُقرأ بعملته. رسالة عربية لأول خطأ.
 */
import { parseAmount } from "./money";

export function readForeignPrices(source: Record<string, unknown>):
  | { ok: true; patch: { priceSarMinor?: number | null; priceUsdMinor?: number | null } }
  | { ok: false; message: string } {
  const patch: { priceSarMinor?: number | null; priceUsdMinor?: number | null } = {};
  for (const [field, key, currency, label] of [
    ["priceSar", "priceSarMinor", "SAR", "بالريال السعودي"],
    ["priceUsd", "priceUsdMinor", "USD", "بالدولار"],
  ] as const) {
    const raw = source[field];
    if (raw === undefined) continue;
    const text = raw === null ? "" : String(raw).trim();
    if (!text) { patch[key] = null; continue; }
    const minor = parseAmount(text, currency);
    if (minor === null || minor < 0) return { ok: false, message: `اكتب سعرًا صحيحًا ${label} أو اتركه فارغًا.` };
    patch[key] = minor;
  }
  return { ok: true, patch };
}
