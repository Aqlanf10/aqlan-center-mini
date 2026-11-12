# M2 slice 95c — historical documents on the canonical runtime (2026-11-07)

Owner decisions G4-1, G4-2 and G4-6 (6648682456). The contract is section 15 of the [Group 4 design](financial-group4-contract-design-20261104.md), including its "95c detail" (points 7 and 8), written before the code.

## Grants

| Act | Legacy | Canonical |
|---|---|---|
| Record a historical document (`POST /historical-documents`) | admin; reception when `finance.reception_adds_opening_balance` is on | `patients.history.record` **and** `finance.patient-ledger.view`. Changing an existing opening also needs `finance.opening-balances.manage`. The discount and any price above the catalogue follow the price grants (`finance.discounts.apply`, `finance.discounts.override`, `finance.price-increases.apply`). |
| Preview it (`POST /historical-documents/preview`) | the same | The new read `read:history.record` (needs `patients.history.record`); the reader also requires `finance.patient-ledger.view`. Same opening and price grants as the record. |
| Correct it (`POST /[documentId]/correct`) | admin | `patients.history.correct`, `finance.opening-balances.manage` **and** `finance.patient-ledger.view`. |

The administrator label, the reception label and the reception setting decide nothing on the canonical path (G4-6). The legacy routes are unchanged.

`created_role`, a published column constrained to `admin` or `reception` and never read back, now records the authority class on the canonical path: `admin` when the actor holds opening management, otherwise `reception` (add only). The audit keeps the actor's username and label as everywhere else (point 8).

## The writers

- `createHistoricalDocumentOn(client, patientId, source, actor, canonical, afterLocks)` and `correctHistoricalDocumentOn(client, patientId, documentId, source, actor, afterLocks)`: the legacy writers on the admitted operation's transaction. The scope is decided right after the patient row lock and before the replay; outside reads as missing (the writer's own `missing`, 404).
- `previewHistoricalDocumentWith(client, patientId, source, actor, canonical)`: the read-only preview on the canonical read snapshot (no lock, no settings lock).
- `canonical = { access, grants }` replaces the label and the reception setting in the opening rule and in the invoice price authority (the same `checkInvoiceAuthority` by grants as invoices since slice 93b).
- The branded actor re-proves every grant the decision used at each point where the writer re-validated its session (start and end of the write, and the replay).
- The legacy `createHistoricalDocument` and `correctHistoricalDocument` keep their transactions, the administrator check on correction, and their results. The correction writer now also refuses a missing patient after the lock (it previously reached the document read and refused there with the same 404).
- The runtime admits two new actions, `patients.history.record` and `patients.history.correct`; the readiness audit's pin is updated with them.
- The canonical routes map refusals through `canonicalHistoryFailure`: the writer's messages and statuses (missing 404, invalid 400, unauthorized 403, stale and conflict 409, busy 409), the ledger-view refusal 403, and the admission refusals as on every canonical patient route. Nothing is cached.

## Open point for the owner

The correction writer accepts new line prices and a new discount without a price check. This was the case on legacy too, where correction was administrator-only. The canonical correction needs opening management, but no price grant. This is the open question already raised in slice 93c (correction price controls); it is not decided here.

## Tests

| Gate | Result |
|---|---|
| PG `history-documents-canonical` | 6/6 |
| Failure-first (two mutations) | Without the after-lock admission, the outside record went through (race test failed: `expected null to match { code: 'missing' }`). Without the ledger check, the record went through (matrix test failed: `expected null to match { code: 'ledger_view_required' }`). Restored, both pass. |
| Legacy PG (every suite using the writers, the runtime, the plan scope helpers or the legacy modules) | 43 files, 837/837 |
| Related unit tests | 9 files, 158/158 |
| Audits | 10/10 |
| tsc | Pass |
| lint | Clean |

The 6 PG tests cover:
- **Record:** a first document creates the opening (45,000); the key replays with the same receipt; a second document is refused for the add-only grant set (preview and record, `unauthorized`) and accepted with opening management (90,000); `created_role` is `reception` then `admin`, `created_by` and the audit actors are the usernames.
- **Grant matrix:** the record grant with opening management but without the ledger view is refused for the preview and the record (`ledger_view_required`); the ledger view with opening management, `finance.legacy.record`, the administrator label and a reception label with the reception setting on are refused for both; nothing is written.
- **Price grants:** a discount is refused without `finance.discounts.apply` (preview and record) and accepted with it; a price above the catalogue is refused without `finance.price-increases.apply`.
- **Correction:** the correction grant without opening management is refused (`unauthorized`); the record grant, opening management alone, the ledger view and the label are refused; the full grant set corrects (version 2, paid 15,000, opening 40,000), the key replays, the audit actor is the username.
- **Scope and revocation:** the `own` doctor gets the same refusal for an outside patient as for a missing one (record and correction `missing`, preview `patient_not_found`); the outside document is untouched; inside the own scope the same grants act; revoking the grants refuses the next record.
- **Race:** the patient leaves the clinician's scope while the record waits for the patient row; the record is refused as missing and writes nothing.
