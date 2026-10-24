# Temporary legacy stock-writer boundary

This separate slice is stacked on dormant safety Draft #467, exact head
`24533e9ee11b8542ffcbacf200761849ea1d0e7c` (tree
`78ea2b459fb54091f5fc2e487d5a1409928ff1f6`). It is not activation or release
approval. No proposal tables are registered, no migration is assigned, and no
live configuration, data or financial policy changes are included.

## Why this restriction is necessary

The legacy manual writer and automatic service-material deduction operate on a
clinic-wide quantity. They cannot identify the valid lot, accountable store or
doctor, or held quarantine reserve. Letting these writers mutate an already
tracked item both bypasses quarantine and makes the allocation ledger incomplete.
The eventual solution is the coordinated, caller-transaction-owned stock adapter
described in `ACTIVATION-INTEGRATION-20261024.md`, not a guessed allocation.

Until then:

- Only exact `INVENTORY_INTEGRATION_ENABLED=true` activates this boundary.
- Off, unset and nonexact values perform no proposal-readiness query or extra
  item lock. Existing legacy behavior remains compatible.
- A tracked item means any `stock_lots` row, irrespective of status, location,
  remaining quantity, expiry or historical origin.
- Under the existing item lock, a separate subsequent statement checks tracking.
  It must see a first lot committed while the writer was waiting for that lock.
- All old quantity mutation forms are refused: issue, purchase, return, positive
  adjustment and negative adjustment. No implicit historical reconciliation occurs.
- An untracked item retains the legacy behavior. Missing/unreadable schema is a
  readiness failure, never evidence that an item is untracked.

The lot-aware procurement/custody writers do not call this legacy helper and are
not accidentally blocked. Existing shared-helper callers (manual movement,
protected purchase and internal action code) receive the same boundary without
modifying or enabling any AI feature. Restricted empty-inventory demo seeding is
not an operational tracked-stock writer.

## Temporary concurrency semantics

Signing already locks patient/visit before deducting materials. Attributed custody
consumption locks the item before validating its patient/visit. A deterministic
PostgreSQL barrier reproduced the resulting `40P01` cycle on the parent head.

When the gate is on, signing acquires all eligible item locks in sorted order with
`NOWAIT`. Only PostgreSQL `55P03` becomes a typed `inventory_busy` HTTP 409. No
global timeout is changed, other SQL errors are not relabelled, and there is no
automatic retry. This is an explicit temporary refusal, not a claim that all
concurrent operations succeed. The whole existing signature transaction rolls
back, including invoice, clinical chart, procedure, stock and audit effects.

The guard checks the same captured material mappings used for deduction, after
existing procedure quantity normalization. It does not precheck one snapshot and
then re-read potentially changed service mappings for the actual write.

The existing clinical form keeps its entered values on a refused response and
allows a deliberate retry. Its existing in-flight request latch is released; no
new client recovery journal is introduced or cleared. A busy untracked signature
can be explicitly retried after the conflicting operation completes, commits once,
and subsequent retries remain `already_signed`.

## Error and recovery contract

- A tracked legacy mutation returns the existing `{ok:false,message}` result before
  movement, payable or mandatory movement-audit insertion. The keyed purchase
  writer therefore preserves its existing durable terminal rejected receipt.
- Exact-key replays of that rejection remain rejected without additional effects.
  Previously committed purchase receipts still replay their original result;
  they create no new movement and must not be reinterpreted by the new guard.
- Clinical tracked refusal is typed `inventory_tracking_required` HTTP 409 and
  never emits a successful visit-sign audit.
- Missing schema and unknown SQL failures roll back and remain safe generic HTTP
  failures. They do not persist a false terminal purchase rejection. The same
  key can be retried when readiness is restored.

## Acceptance evidence and remaining restrictions

The real-PostgreSQL red tests show the parent permitted tracked manual mutations,
supplier purchases and mixed-material signing. Forced item/visit barriers show the
actual deadlock, not a timer-only approximation.

Regression checks cover full clinical state and tooth-chart rollback, safe API
classification, exact-key purchase replay, first-lot concurrency, reversed
multi-item signing, and explicit busy recovery. Final validation counts and exact
reviewed commit must be reported with the Draft rather than inferred from this
design document.

The existing reconciliation tests intentionally model malformed pre-activation
history. They now first assert that the guarded live writer refuses a tracked
mutation, then insert that historical movement directly into the isolated
synthetic database. This fixture-only setup preserves the original incomplete-
allocation and outflow-before-inflow rejection assertions; it is not a repair
path, a guard bypass offered to operators, or evidence that live data was fixed.

This restriction deliberately reduces enabled-mode functionality until the shared
adapter exists. It does not deliver patient-cost completeness, financial invoice
posting, supplier credit/cancellation, durable new-module command recovery or
operational master-data setup. Gate-off compatibility is not permission to turn
tracking off after live tracked stock is introduced; rollback-mode safety remains
part of the separately reviewed activation plan. Production and Staging stay
unchanged, and the user's Staging acceptance is still required before release.
