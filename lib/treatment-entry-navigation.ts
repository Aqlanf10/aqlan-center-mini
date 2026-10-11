/** A draft may be discarded explicitly; an in-flight financial write may not.
 * This predicate never interprets an unconfirmed request as a cancelled write. */
export function canLeaveTreatmentEntry(state: {
  active: boolean;
  pending: boolean;
  hasDraft: boolean;
}, confirmLeave: () => boolean): boolean {
  if (!state.active || state.pending) return false;
  return !state.hasDraft || confirmLeave();
}
