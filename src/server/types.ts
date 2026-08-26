import type { FieldErrors } from "@/lib/validation";

/**
 * Uniform result shape returned by all server actions so client forms can
 * map `messageKey`/`errorKey`/`fieldErrors` through the active dictionary.
 */
export type ActionResult =
  | { ok: true; messageKey: string; id?: string }
  | { ok: false; errorKey: string; fieldErrors?: FieldErrors };

export function success(messageKey: string, id?: string): ActionResult {
  return { ok: true, messageKey, id };
}

export function failure(
  errorKey: string,
  fieldErrors?: FieldErrors
): ActionResult {
  return { ok: false, errorKey, fieldErrors };
}
