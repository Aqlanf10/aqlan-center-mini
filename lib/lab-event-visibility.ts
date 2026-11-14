import "server-only";
import type { LabOrderTrackingEvent } from "./lab";

/** Classify tracking payloads by their actual writers, not role labels or words in
 * their free text. Unknown kinds stay private until their visibility is reviewed.
 * Clinical notes are clinical data, just as in the order's clinical projection. */
const CLINICAL_EVENTS: ReadonlySet<string> = new Set([
  "create", "status_change", "due_date_change", "quality_check",
  "marked_for_remake", "created_as_remake", "prescription_completed",
  "prescription_draft_saved", "work_intent_materialized",
]);
const ACCOUNTING_EVENTS: ReadonlySet<string> = new Set(["accounting_posted", "accounting_updated"]);
const SETTLEMENT_EVENTS: ReadonlySet<string> = new Set(["financial_settlement", "financial_settlement_reversed"]);

/** Server-side projection; never changes the persisted audit trail.
 *
 * The order DTO's cost grant covers its accounting/status group. It does NOT grant
 * expense-voucher details. Settlement notes contain the WHOLE batch amount and
 * reversals an arbitrary reason. Historical rows may have no expense_id, so neither
 * parsing their text nor checking only this order's patient can prove their scope.
 * Return those opaque notes only with expense visibility AND the whole patient
 * scope. Keep the permitted event metadata when its note cannot be disclosed. */
export function visibleLabOrderEvents(
  events: readonly LabOrderTrackingEvent[],
  visibility: { readonly costs: boolean; readonly expenses: boolean; readonly allPatients: boolean },
): LabOrderTrackingEvent[] {
  return events.flatMap(event => {
    if (CLINICAL_EVENTS.has(event.action)) return [event];
    if (!visibility.costs) return [];
    if (ACCOUNTING_EVENTS.has(event.action)) return [event];
    if (SETTLEMENT_EVENTS.has(event.action)) {
      return [{ ...event, notes: visibility.expenses && visibility.allPatients ? event.notes : null }];
    }
    return [];
  });
}
