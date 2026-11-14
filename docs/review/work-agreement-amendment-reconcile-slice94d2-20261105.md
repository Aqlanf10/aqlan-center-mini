# M2 slice 94d-2 — the agreement amendment and the agreement reconciliation on the canonical runtime (2026-11-05)

Owner decisions G4-1 and G4-8 (6648682456). The contract is section 13 of the [Group 4 design](financial-group4-contract-design-20261104.md), written before the code. The routes are `GET`, `POST` and `PUT` on `/api/plans/[id]/agreement-amendment` and on `/api/plans/[id]/reconcile`.

## Grants

| Method | Legacy | Canonical |
|---|---|---|
| `GET` (the preview and its source hash) | the administrator label | `finance.agreements.manage` inside the patient scope |
| `POST` (the amendment's delta invoice, or the reconciliation's unbilled principal) | the administrator label | `finance.agreements.manage` inside the patient scope |
| `PUT` (the status of one exact attempt) | the administrator label | `finance.agreements.manage` inside the patient scope |

The catalogue requires `finance.patient-ledger.view` with `finance.agreements.manage`. No other grant substitutes: `finance.invoices.create`, the ledger view and collect alone are refused on all six methods. The administrator label alone decides nothing.

## The writers

The writers are unchanged:
- the request digest bound to the actor's user id;
- the advisory attempt fence;
- the committed stale-rejection proof;
- the patient row, debt-account, plan-item or plan, doctor and policy locks;
- the snapshot and its source hash;
- the delta invoice, the event row and the audit, all in the same transaction.

Each is split into an `…On` form on the caller's transaction: `saveAgreementAmendmentOn`, `readAgreementAmendmentAttemptStatusOn`, `saveAgreementReconciliationOn` and `readAgreementReconciliationAttemptStatusOn`. The previews are `readAgreementAmendmentWith` and `readAgreementReconciliationWith`. The legacy functions keep their own transactions, messages and status codes.

The canonical actor is the slice 91 branded actor. At each point where the writer re-validated the legacy session, it re-proves the live operation and `finance.agreements.manage` on the same client.

A stale source still commits its rejection proof before the refusal. The `…On` form returns the stale outcome; the operation commits it; the route then answers the legacy 409 with the legacy message (`stale` for the amendment, `agreement_source_changed` for the reconciliation). Every other refusal rolls back.

## Scope

- **Reads:** one read-only snapshot under the new record read `read:plans.agreement`. The plan resolves to its patient in that snapshot. An outside plan reads exactly like a missing one (the writer's own 404 refusal).
- **Writes:** an early unlocked look, then the authoritative decision right after the patient row lock, before the replay under the lock and before any rejection proof. An `own` actor needs a positive ownership witness `FOR SHARE NOWAIT`. On the canonical path the replay and the stale check before the locks are skipped.
- **Status:** the patient row is held `FOR SHARE` to decide the scope before any saved attempt is read. Nothing is written.

## Tests

| Gate | Result |
|---|---|
| PG `plan-agreements-canonical` | 4/4 |
| Race failure-first | Without the after-lock admission, the outside amendment went through (the test failed). Restored, it passes. |
| Legacy PG (every suite touching the two writers or the record reads) | 20 files, 454/454 |
| Related unit tests | 9 files, 243/243 |
| Related HTTP journeys (amendment, delta upgrade, split allocation, billing guard) | In the batch gate on the built head (this worktree has no build) |
| Audits | 10/10 |
| tsc | Pass |
| lint | Clean |

The 4 PG tests cover:
- **Amendment:** the preview; the delta invoice and its audit by the manager; the replay of the same key; the committed status. A stale source writes its rejection proof and is refused; `PUT` reports `rejected_stale`; the same key stays refused; there is one event.
- **Reconciliation:** the preview; the receipt and its audit; the replay; the committed status. A stale source writes its rejection proof and is refused; `PUT` reports `rejected`; nothing is reconciled.
- **Refusals:** `finance.invoices.create`, the ledger view, collect alone and the label are refused on all six methods. The `own` doctor gets the same code, message and error type for an outside plan as for a missing one on all six; inside its scope it reads the preview. Revocation between two calls is refused.
- **Race:** the patient leaves the doctor's scope while the amendment waits for the patient row. The amendment reads as missing, and no event or rejection proof is written.

## Notes

- On the canonical path the body is parsed before the operation is admitted, as in slices 94b to 94d-1. A malformed body from an actor without the grant gets 400 rather than 403; nothing is read or written either way. The legacy path keeps its order (authority before body shape).
- No migration and no schema change. The amendment's table (runtime migration 0066) is unchanged.
