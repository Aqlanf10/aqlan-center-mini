/**
 * Duplicate-patient detection helpers (pure functions, unit-tested).
 *
 * Family members may legitimately share a mobile number, so a shared
 * number is never a hard block — the UI only surfaces a warning with
 * links to the possible existing records.
 */

/** Lowercase + collapse inner whitespace so names compare consistently. */
export function normalizeNameForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Extract only digits from a phone-ish string. */
export function digitsOnly(value: string): string {
  return value.replace(/\D+/g, "");
}

/**
 * Last `n` digits of a number (default 9 = a Yemeni subscriber number
 * without the country code). Comparing suffixes treats "+9677xxxxxxx"
 * and "07xxxxxxx" as the same line.
 */
export function mobileTail(value: string, n = 9): string {
  const digits = digitsOnly(value);
  return digits.slice(-n);
}

/** Do two phone values look like the same line (suffix match, min 8)? */
export function mobileLooksSimilar(a: string, b: string): boolean {
  const tailA = mobileTail(a);
  const tailB = mobileTail(b);
  if (tailA.length < 8 || tailB.length < 8) return false;
  return tailA === tailB;
}

export type DuplicateReason = "mobile" | "nameAndMobile";

export type SimilarPatient = {
  id: string;
  fileNumber: string;
  fullName: string;
  mobile: string | null;
  reason: DuplicateReason;
};

type ExistingPatient = {
  id: string;
  fileNumber: string;
  fullName: string;
  mobile: string | null;
  alternateMobile: string | null;
};

/**
 * Classify why an existing record may be a duplicate of the form input:
 * - "mobile": the entered number matches this patient's mobile or
 *   alternate number (exact or same-line suffix).
 * - "nameAndMobile": same normalized name AND a similar number.
 */
export function classifyDuplicate(
  existing: ExistingPatient,
  input: { fullName: string; mobile: string }
): DuplicateReason | null {
  const nameMatch =
    normalizeNameForMatch(existing.fullName) ===
    normalizeNameForMatch(input.fullName);

  const mobileMatch =
    (existing.mobile !== null &&
      mobileLooksSimilar(existing.mobile, input.mobile)) ||
    (existing.alternateMobile !== null &&
      mobileLooksSimilar(existing.alternateMobile, input.mobile));

  if (mobileMatch && nameMatch) return "nameAndMobile";
  if (mobileMatch) return "mobile";
  return null;
}
