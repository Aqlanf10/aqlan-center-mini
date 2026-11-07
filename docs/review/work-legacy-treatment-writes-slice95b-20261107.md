# M2 slice 95b — pre-system treatments on the canonical runtime (2026-11-07)

Owner decisions G4-1, G4-2 and G4-6 (6648682456). The contract is section 15 of the [Group 4 design](financial-group4-contract-design-20261104.md), including its "95b detail", written before the code.

## Grants

| Act | Legacy | Canonical |
|---|---|---|
| Record a pre-system treatment (`POST /legacy-treatments`) | admin; reception when `finance.reception_adds_opening_balance` is on | `finance.legacy.record`. Increasing an existing opening also needs `finance.opening-balances.manage`. |
| Preview it (`POST /legacy-treatments/preview`) | the same | `read:legacy.record` (needs `finance.legacy.record`). The opening effect is shown; its amounts only with `finance.patient-ledger.view`. |
| Void preview and apply (`GET`/`POST /[agreementId]/void`) | admin | `finance.legacy.void` **and** `finance.patient-ledger.view`. The `manager_authorized` exception also needs `finance.opening-balances.manage`. |

The administrator label, the reception label and the reception setting decide nothing on the canonical path (G4-6). The legacy routes are unchanged.

**Policy points for the owner** (recorded in section 15; recommended, not decided):
1. Record adds an opening; changing an existing one also needs opening management.
2. The reception setting is not a grant.
3. Correcting a historical document also needs opening management (95c).
4. Void keeps the map's `finance.legacy.void` grant.
5. Void also needs the ledger view, because its preview and response show amounts recorded by someone else.
6. The administrator exception mode needs opening management.

## The writers

- `createLegacyTreatmentOn(client, input, afterLocks)`: the legacy writer on the admitted operation's transaction. The scope is decided right after the patient row lock, before the replay and every decision. With repayment terms, the writer's label-and-setting check is replaced by the branded actor's re-check of the same grants.
- `previewLegacyTreatmentWith`, `getLegacyVoidPreviewWith`: the read-only previews on the canonical read snapshot.
- `voidLegacyTreatmentOn(client, input, afterLocks)`: the void on the operation's transaction, the scope decided right after the patient row lock.
- The legacy functions keep their transactions, label checks and results. Every refusal returns the legacy reason, message and status, and the operation then rolls back.
- The runtime admits two new actions, `finance.legacy.record` and `finance.legacy.void`; the readiness audit's pin is updated with them, as slice 93c did for `finance.invoices.correct`.

## Tests

| Gate | Result |
|---|---|
| PG `legacy-treatment-writes-canonical` | 5/5 |
| Race failure-first | Without the after-lock admission, the outside record went through (the test failed). Restored, it passes. |
| Legacy PG (every suite using the writer, the runtime or the plan scope helpers) | 31 files, 597/597 |
| Related unit tests | 19 files, 421/421 (three source-contract assertions repointed, see below) |
| Audits | 10/10 |
| tsc | Pass |
| lint | Clean |

The 5 PG tests cover:
- **Record:**
  - a first agreement creates the opening (180,000);
  - the key replays;
  - an increase is refused for the record grant alone (`opening_edit_forbidden`, opening unchanged) and accepted with opening management (360,000);
  - the creators are audited.
- **Grant matrix:**
  - the ledger view, the history grant, collect, the administrator label and a reception label with the reception setting on are refused, for the record and the preview, and nothing is written;
  - the preview shows the effect without amounts for the record grant, and the amounts with the ledger view;
  - an increase previews as refused for the record grant alone.
- **Void:**
  - the void grant without the ledger view is refused for the preview and the apply;
  - the exception mode without opening management is refused;
  - record, ledger and the label are refused;
  - the ordinary void with the ledger view applies, clears the opening and is audited by the actor.
- **Scope and revocation:**
  - the `own` doctor gets the same refusal for an outside patient as for a missing one (record `no_patient`, void `not_found`, preview `patient_not_found`), and the outside agreement is untouched;
  - revoking the record grant refuses the next record.
- **Race:** the patient leaves the doctor's scope while the record waits for the patient row. The record answers `no_patient`, and no agreement or opening is written.

## Note

Two legacy messages name the administrator: `opening_edit_forbidden` says adding to an existing opening is "for the administrator", and `void_forbidden` says voiding is "for the administrator only". The canonical path keeps the legacy messages as the contract requires. On canonical sessions the meaning is the grant, so the wording is an owner choice for a later screen pass.

## Source-contract tests repointed

Two unit suites read the legacy writer's source text by function name. The logic they check now lives in the shared forms, so the same assertions are applied there, and new assertions prove each legacy entry delegates to them. Nothing was relaxed:

| Suite | Assertion | Now checked on |
|---|---|---|
| `legacy-treatment-release-contract` | lock order (patient, plans, items, agreements) | `voidLegacyTreatmentOn`; the entry must call `voidLegacyTreatmentOn(client, input)` |
| `legacy-treatment-release-contract` | financial review hold, no deletes, preview before opening change, `preview_stale` | `voidLegacyTreatmentOn` |
| `legacy-treatment-release-contract` | the administrator label check | the legacy entry `voidLegacyTreatment` (where it stays) |
| `legacy-treatment-identity-scope` | the preview uses the writer's decision unlocked | `previewLegacyTreatmentWith`; the entry keeps `READ ONLY` and must delegate; neither writes |
