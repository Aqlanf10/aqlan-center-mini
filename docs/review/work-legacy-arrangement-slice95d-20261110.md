# M2 slice 95d — the previous-balance collection arrangement on the canonical runtime (2026-11-10)

Owner decisions G4-1, G4-2 and G4-6 (6648682456). The contract is section 15 of the [Group 4 design](financial-group4-contract-design-20261104.md), "95d detail", written before the code. This closes slice 95 (95a reads, 95b pre-system treatments, 95c historical documents, 95d arrangement).

## Grants

| Act | Legacy | Canonical |
|---|---|---|
| Create an arrangement (`POST /legacy-balance-arrangement`) | admin, reception | `finance.legacy.record` **and** `finance.patient-ledger.view` |
| Cancel it (`PATCH`) | admin, reception | the same |

**Point 9 for the owner (recommended, not decided):** the ledger view is required because the create response shows the opening position (`startingDueMinor`, progress) and the screen that offers both acts is the ledger read. An arrangement never changes an opening, so `finance.opening-balances.manage` is not needed. The label decides nothing. The legacy routes are unchanged.

## The writers

- `createLegacyBalanceArrangementRowOn(client, input, afterLocks?)`: the legacy body on a caller's transaction. Every refusal is decided before the insert. The legacy `createLegacyBalanceArrangement` is now a thin wrapper around it with the same transaction, the same unique-violation mapping and the same result.
- `createLegacyBalanceArrangementOn` (canonical) adds the view on the same transaction; `cancelLegacyBalanceArrangementOn` takes the patient row lock, then the scope, then the same update and refusals.
- The scope is decided right after the patient row lock; outside reads as missing (`patient_not_found` for create, `not_found` for cancel).
- **Two gaps of the legacy path are closed on the canonical path only:** the audit row is written in the same transaction as the arrangement (legacy writes it best-effort after the commit), and cancel takes the patient row lock (legacy takes none).
- The route validates the request with the legacy validation, now shared by both session kinds (`readCreate`, `readCancel`); messages and statuses are unchanged.
- No new runtime action: `finance.legacy.record` was admitted in slice 95b.

## Tests

| Gate | Result |
|---|---|
| PG `legacy-arrangement-canonical` | 4/4 |
| Failure-first (two mutations) | Without the after-lock admission the outside create went through (race test failed: `expected null to match { reason: 'patient_not_found' }`). Without the ledger requirement the blind actor reached the writer (matrix test failed, expecting `ledger_view_required`). Restored byte for byte; both pass. |
| Related PG (arrangement, ledger, debt-instalment and canonical legacy suites) | 27 files, 273/273 |
| Related unit tests | 9 files, 175/175 |
| Audits | 10/10 |
| tsc | Pass |
| lint | Clean |

The 4 PG tests cover:
- **Create and cancel:** the arrangement is created against the opening (90,000) by the actor; a second one is refused (`already_active`); cancel of a missing id is `not_found`; cancel succeeds once and is then `already_cancelled`; both acts are audited by the actor; an instalment above the remaining and a patient without an opening are refused, and refused attempts write no arrangement and no audit row.
- **Grant matrix:** the record grant without the ledger view is refused for both acts (`ledger_view_required`); the ledger view with opening management, the history grant, the administrator label and the reception label are refused for both; nothing changes.
- **Scope and revocation:** the `own` doctor gets the same refusal for an outside patient as for a missing one, for create and cancel; the outside arrangement is untouched; inside the own scope the grants act; revoking the grants refuses the next create.
- **Race:** the patient leaves the clinician's scope while the create waits for the patient row; it is refused as missing and writes nothing.
