# Caller-owned lot receipt adapter: bounded readiness, not activation

Base: combined staging candidate `d9371706931230584aa6c7c7f9374837bb7fa786`.
The earlier pure usage structure contract `dd93c03bba7cfef46bd243eb2cc48f2ec6a00637`
is not needed by this nonclinical receipt slice and is not silently composed here.

## What this slice provides

- `postInspectedReceiptInTransaction(client, actor, key, receipt)` performs the
  same stock-only command as `postInspectedReceipt`, on an existing caller-owned
  transaction and connection. Both use scope `receipt.post`, the same payload
  digest and the same actor-scoped durable operation result.
- The extracted command validates the exact existing opt-in gate, probes for an
  explicit transaction, revalidates the existing live administrator identity,
  serializes the command key, and replays a committed result before rechecking
  mutable destination state. It does not constitute authentication by itself:
  the outer entry point must supply its authenticated actor, as before.
- The transaction probe creates and releases a fixed-name savepoint. PostgreSQL
  rejects autocommit before any business query; only SQLSTATE `25P01` becomes
  `transaction_required`. Aborted transaction and other database failures retain
  their original identity. A caller's existing same-name savepoint is preserved.
- The caller still owns BEGIN, COMMIT, ROLLBACK and connection release. It must
  roll back on **every** thrown failure. There is no inner commit, catch-and-save,
  connection lookup, schema provisioning, automatic retry or fallback to the
  legacy stock/purchase writer. No new HTTP, signing or legacy entry is wired.
- An active same-scope store or explicitly owned doctor custody location is
  required. Transit is not a final receipt destination. Custody requires its
  existing configured owner to be an active doctor; the actor/performer is never
  substituted and no owner is selected or changed.

## Atomic effects and retained boundaries

A new command creates its receipt header/lines, stock movements, lot snapshots,
complete location allocations, mandatory audit and durable command result in the
single caller transaction. Rejected inspection portions remain documentary, not
stock. Partial capacity, posting-date expiry, quarantine and order-amendment
rules use the existing planners without policy changes.

Receipts are not invoices. They never create a payable, expense or payment.
Movement unit cost remains NULL, while each lot keeps the original native
YER/SAR/USD quote and exact conversion, labelled estimated with financial
valuation pending. A tiny converted piece cost is not rounded to zero; an
explicit quote zero stays a recorded quote zero, not an asserted final cost.
The completeness-aware reader continues to report unknown final value as NULL.
No commission, payroll, settlement or historical cost rule changes.

Legacy keyed purchases retain their own command receipt/replay semantics and
legacy stock-plus-payable path. This adapter does not consume or rewrite those
receipts. Feature-off legacy behavior and dormant-API refusal remain intact.

## Lock order

Actor SHARE → actor-scoped command advisory lock → order UPDATE → sorted
location SHARE → sorted explicit custody owner SHARE → sorted item UPDATE →
receipt/lot/allocation/audit/operation writes. A committed replay exits before
order/destination revalidation. The exported core's savepoint probe precedes this
sequence but does not add a data or advisory lock.

Existing custody dispatch, acknowledgement and usage also lock location, owner
and then item. Party-edit paths may update/lock the party but do not subsequently
acquire inventory item/location locks. No application location-editor writer was
found on this base. Historical reconciliation takes item then location SHARE,
but only supports store destinations; SHARE location reads do not conflict with
receipt SHARE reads. Any future location-owner editor must be separately reviewed
against these orders and retain immutable ownership evidence.

Deterministic PostgreSQL barriers verify both owner races: deactivation already
holding the party lock makes the receipt wait and then refuse before item locks;
a verified receipt holds the owner stable until its commit, after which an owner
change blocks new receipts but cannot alter the earlier committed replay.

## Verification contract

- Baseline red: transit, missing custody owner, supplier owner and inactive doctor
  owner were incorrectly accepted. All four refuse with no effects after the fix.
- Autocommit misuse was demonstrated red before the transaction probe was added.
- Injected failure after each header, line, movement, lot, allocation, audit and
  operation-result insert rolls back all effects together with a caller sentinel.
- Explicit-transaction success does not acquire a second connection or release
  the caller connection. Caller savepoint and rollback remain functional.
- Missing schema rolls back caller work; disabled/unknown gate values issue zero
  queries, including zero savepoint probes. Other probe failures are not masked.
- Shared wrapper/core replay, changed-payload conflict, distinct-key duplicate
  receipt refusal, revoked actor, partial completion, three native quote
  currencies, quote zero, expiry/quarantine/return/replacement are covered.

## Local verification result

Node 22.23.3 and isolated synthetic PostgreSQL 18.6: all 393 inventory unit tests
(17 files), all 343 inventory PostgreSQL tests (14 files, including 23 new
adapter cases), full typecheck and changed-file lint pass. Ten new unit cases
cover the explicit-transaction/gate failure boundary. Production code was
reviewed before broad regressions. Full build, hosted CI, built HTTP/browser
and live environment checks were not run for this slice.

## Remaining activation blockers

This is **not** full inventory/purchasing activation or a release approval.

1. Supplier invoice revision, match/approval and cancellation must integrate a
   caller-owned native payable writer and immutable source links. The current
   `createPayable` uses pool queries. One approved supplier invoice must create
   one debt, while receipts never duplicate debt and invoice approval never
   duplicates stock. Source-linked reversal/credit handling, existing payment
   and payment-void guards, and native-currency reconciliation need end-to-end
   review. Opening balances are not a substitute for supplier credits.
2. Operational manual/custody/clinical issue adapters, cross-entry actual-use
   identity, truthful cost readers at every affected financial boundary and
   durable actor-scoped client recovery are not completed by receipt extraction.
3. Owner decisions about actual usage versus templates, explicit custody source
   selection/authority, and automatic commission treatment remain unanswered.
   No double deduction or new policy is inferred from permission to fix defects.
4. Proposal schema remains unregistered. Root must reserve migration numbers
   after collision review, select required objects rather than blanket-register
   all proposal tables, and prove additive upgrades/integrity checks. Verified
   package factors, locations and purchase approval limits remain prerequisites.
5. Independent exact-head review/CI, end-to-end purchase-to-payment/reversal and
   custody tests, built HTTP/browser evidence, staging acceptance and separately
   authorized production rollout are still required. The flag stays OFF.
