/** undefined: first successful feed has not arrived; null: it arrived empty. */
export type DisplayCallCursor = string | null | undefined;

export function readDisplayCallAlert(
  cursor: DisplayCallCursor,
  feedReady: boolean,
  callKey: string | null,
  allowSpeech: boolean,
): { cursor: DisplayCallCursor; alert: boolean; speech: boolean } {
  if (!feedReady) return { cursor, alert: false, speech: false };
  // The first feed establishes the baseline even if it contains no calls.
  if (cursor === undefined) return { cursor: callKey, alert: false, speech: false };
  if (callKey === null || callKey === cursor) return { cursor, alert: false, speech: false };
  return { cursor: callKey, alert: true, speech: allowSpeech };
}
