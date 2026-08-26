/**
 * Phone normalization + WhatsApp deep links (wa.me).
 *
 * Clinic default country: Yemen (+967). Numbers already stored in full
 * international format are preserved as-is; local numbers are upgraded to
 * international. The app never sends messages automatically — links only
 * open the conversation for the staff member.
 */

export const DEFAULT_COUNTRY_CODE = "967";

/** Remove display characters from a phone number. */
function stripFormatting(value: string): string {
  return value.replace(/[ ()\-.\u200f\u200e]/g, "");
}

export type PhoneNormalization =
  | { ok: true; e164: string; digits: string }
  | { ok: false; reason: "empty" | "invalid" };

/**
 * Normalize any stored/entered phone value to E.164-ish (+<digits>).
 *
 * - "+967 712 345 678" → "+967712345678" (international preserved)
 * - "00967 712 345 678" → "+967712345678" (00-prefix converted)
 * - "967712345678" → "+967712345678" (missing + assumed international
 *   when it already starts with the country code)
 * - "712345678" → "+967712345678" (Yemeni local mobile)
 * - "0712345678" → "+967712345678" (leading national zero stripped)
 */
export function normalizePhone(
  value: string,
  countryCode = DEFAULT_COUNTRY_CODE
): PhoneNormalization {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty" };
  }

  const hasPlus = trimmed.startsWith("+");
  const digits = stripFormatting(trimmed);

  if (!digits || !/^\+?\d+$/.test(digits)) {
    return { ok: false, reason: "invalid" };
  }

  let national = digits.replace(/^\+/, "");
  if (national.startsWith("00")) {
    national = national.slice(2);
    if (!national) return { ok: false, reason: "invalid" };
    return { ok: true, e164: `+${national}`, digits: national };
  }

  if (hasPlus || national.startsWith(countryCode)) {
    return { ok: true, e164: `+${national}`, digits: national };
  }

  // Local national number: strip a single leading zero, add country code.
  const local = national.replace(/^0+/, "") || national;
  if (!local) return { ok: false, reason: "invalid" };
  return { ok: true, e164: `+${countryCode}${local}`, digits: `${countryCode}${local}` };
}

/**
 * Build a wa.me deep link. `message` is URL-encoded as the prefilled text.
 * Returns null when the number cannot be normalized.
 */
export function buildWhatsAppLink(
  phone: string,
  message?: string,
  countryCode = DEFAULT_COUNTRY_CODE
): string | null {
  const normalized = normalizePhone(phone, countryCode);
  if (!normalized.ok) {
    return null;
  }
  const base = `https://wa.me/${normalized.digits}`;
  if (!message || !message.trim()) {
    return base;
  }
  return `${base}?text=${encodeURIComponent(message.trim())}`;
}

/** True when the stored value is already in international format. */
export function isInternationalPhone(value: string): boolean {
  const normalized = normalizePhone(value);
  if (!normalized.ok) return false;
  // Already international if the raw value carried + or 00, or if it was
  // long enough to include a country code (>= 12 digits incl. country).
  return value.trim().startsWith("+") || value.trim().startsWith("00");
}
