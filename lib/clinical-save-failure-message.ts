/** Fetch transport failures must not replace the localized retry guidance.
 * Preserve explicit validation/command errors from the clinical save boundary. */
export function clinicalSaveFailureMessage(reason: unknown): string {
  return reason instanceof TypeError || !(reason instanceof Error)
    ? "تعذّر الاتصال بالخادم." : reason.message;
}
