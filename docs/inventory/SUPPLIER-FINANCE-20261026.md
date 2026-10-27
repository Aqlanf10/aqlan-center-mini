# Prepared supplier invoice finance core

This is a dormant, caller-owned core on the inventory continuation branch, not an
operational endpoint or activation approval. No HTTP command, UI, numbered
migration, runtime provisioning, deployment or private flag change is added.
Migration numbers 0070–0082 remain reserved elsewhere.

## Source and accounting contract

`createSupplierInvoiceFinanceService` exposes `revise`, `post` and `cancel` on an
explicit caller transaction. The caller must roll back every thrown failure.
Each command requires the exact invoice version and SHA-256 document digest,
reason, current live admin authority, and an operation key. Mandatory audit,
source evidence, canonical debt effect and successful replay result commit
together. Receipt posting remains stock-only; these commands never change stock,
lots, expenses, cash, patient costs or payroll.

Before posting, revisions append a new document and match result. Supplier,
order, currency, clinic scope and normalized supplier invoice duplicate identity
remain fixed; version advances by one. Original documents and reservations are
not updated or deleted. The current revision's accepted receipt allocations are
used by both new commands and existing invoice matching/workbench readers.
Without the additive proposal those existing readers retain their old source.
Post requires an explicitly matched saved revision and rechecks the current order
revision and accepted receipt capacity. An unresolved invoice must first receive
an explicit matched revision; a later receipt does not silently approve it.

Posting calls `createPayableInTransaction` and appends the existing unique
invoice-to-payable link plus exact approved revision/realm metadata. Different
keys or actors cannot create another debt for the same invoice. YER, SAR and USD
remain native currencies. The frozen valuation must fit PostgreSQL
`numeric(18,6)` exactly, survive the canonical writer's numeric representation,
and produce exactly the approved base amount. Unsupported precision or conversion
parity is refused; there is no silent rounding or replacement FX quote.

Cancellation is full, terminal and source-linked. Only an unchanged posted
inventory payable with **zero net direct and allocated settlement** can be
cancelled. Otherwise the command refuses and the existing authorized payment-void
flow must be used first, preserving its shift/reason/audit guards. The core does
not automatically void payments, refund cash, create advances or return goods.
An inactive supplier cannot receive a new posted debt, but live authorized admin
cancellation of its existing debt remains possible.

The negative amount uses canonical `payable_adjustments` storage through this
narrow operational writer, with immutable cancellation evidence referencing the
exact adjustment and payable. It never calls `adjustPartyOpeningPayable` or
changes that route's opening-only contract. `listPartyOpenings` now filters its
adjustments to opening payables, preventing operational cancellation evidence
from appearing as an opening correction. Existing native and base party-balance
projections already include canonical adjustments. `Payable.baseAmountMinor`
retains its original frozen snapshot semantics; effective native amounts and
effective canonical party balances are separate projections. No DTO field is
silently repurposed.

Cancelled invoices cannot be revised or posted by a fresh command. Replaying an
original committed posting key returns its historical acknowledgement unchanged,
marked as replayed; it does not recreate debt or override the later cancellation.
The same historical acknowledgement rule applies to the original cancellation
key. Accepted receipt reservations
remain held as immutable source evidence, so cancellation cannot re-invoice the
same goods. Partial credits, replacement invoices, invoice-number corrections,
reservation release and stock returns require separately reviewed lifecycles.

## Additive proposal and concurrency

`supplier-finance-schema-proposal.ts` is unnumbered and explicitly installed only
in disposable tests. It adds finance roots, revisions, posting metadata,
cancellations and effective-source views. Append-only guards protect the added
evidence. Guards on inventory-linked payables prevent mutation/deletion; unrelated
HR, lab and other finance payables are outside that guard's restriction. Deferred
constraints require new invoice links/postings and operational adjustments to
have exact immutable source evidence by commit. Existing links are not rewritten.

The core retains live actor SHARE → operation-key advisory locking, then locks
order → original invoice → supplier party → payable. This matches the existing
payment writer's party → payable order. It does not modify payment/void locks.
The existing void writer's inserted expense can also hold foreign-key locks on
party/payable until commit; cancellation waits and rereads the canonical balance.
Posting and revision serialize on the same order/invoice source; unique source
links also fence different actors and different operation keys.

## Authoritative identity seam remains closed

The explicit service dependency `resolvePrincipal(actor)` must return a stable
server-owned realm ID and subject ID bound to the authenticated numeric actor ID
and username. Default construction returns no principal and fails closed. There
is no environment flag, request field, client identifier or clinic-name fallback.
Tests construct the dependency with a synthetic resolver. Realm and subject bind
the operation scope and payload digest; the invoice root pins the realm, and a
different realm cannot reuse that invoice. The existing store still revalidates
the actor's active status and role. This interface is an integration seam, not a
new authentication system. Until the canonical identity adapter is supplied,
financial HTTP dispatch remains absent.

## Validation record

Synthetic PostgreSQL 18.6 only, loopback port 54339 in disposable container
`aqlan-inventory-supplier-20261026`; Node 22.23.3. Logs are preserved outside the
repository in `/workspace/inventory-resume-evidence/supplier-*`.

Initial focused run: 10 tests passed. Expanded run: 16 passed and one fixture
failed because it awaited cancellation while holding an uncommitted payment-void
transaction; the synthetic blocked statement was cancelled to release that test.
The corrected test uses concurrent execution and an explicit lock-entry barrier,
without changing product locks. A subsequent run passed 17 of 18: its stale-order
fixture attempted a no-op amendment, correctly rejected by the existing approved
source rule. The fixture now adds a genuinely approved supplementary source;
the product rule was not weakened. A test-only TypeScript namespace error was
fixed with an explicit `DbClient` type import; the next typecheck passed.

Final focused PostgreSQL regressions: **9 files / 164 tests passed**, including
all **18 new supplier finance cases**, in 70.96 seconds. The round includes
existing procurement, payable transaction/overpayment, party statements and
opening-balance/currency/period-lock cases. Existing pg concurrent-query
deprecation warnings were emitted and not suppressed. Focused domain/rollout/API
registration/payable units: **4 files / 104 tests passed**, 5.92 seconds. Final
typecheck, money-aggregation guard and `git diff --check` passed. Changed-file
lint passed with zero errors and eight existing `db.ts` warnings.
After review, the three native-currency cases also assert historical post/cancel
acknowledgements after cancellation. The final supplier-only rerun passed all
**18 cases**, 5.90 seconds (`supplier-postgres-final.log`).

No build or browser round was repeated for this prepared core, which adds no
endpoint or UI. The earlier browser evidence belongs to the previous recovery
slice and is not a supplier financial endpoint acceptance claim.
There is no supplier UI/browser or operational endpoint acceptance claim. Durable
terminal-command retirement, final valuation/patient consumption cost integration,
registered schema, master data and restoration acceptance remain separate work.
