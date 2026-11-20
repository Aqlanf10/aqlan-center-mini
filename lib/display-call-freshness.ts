/** Per-tab scalar fence. Displaying a selected row is not evidence of a new
 * event: a previously hidden or superseded row can become visible again.
 * Only the server's observed clock is used; no patient/name/room data is kept. */
export function createDisplayCallFreshness() {
  let through: number | null = null;
  return {
    observe(serverNow: string, call: { at: string | null } | null, baseline: boolean): boolean {
      const now = Date.parse(serverNow);
      if (!Number.isFinite(now)) return false;
      const previous = through;
      through = previous === null ? now : Math.max(previous, now);
      const called = call?.at ? Date.parse(call.at) : NaN;
      // A tie, absent time, future apparent time, or clock rollback is not
      // proof of a fresh event. Empty polls still advance the coverage fence.
      return !baseline && previous !== null && Number.isFinite(called) && called > previous && called <= now;
    },
  };
}
