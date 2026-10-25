# Inventory activation: current boundary and next integration slices

Source baseline: `c998b435306f8295a217e49f20080293c479c359`, reviewed on 2026-10-24.
This document is an implementation plan, not approval to activate or deploy.
Production and Staging settings remain unchanged. The private feature flag stays
closed. No migration number is reserved by this change.

## Why the module is not operational yet

PRs #331 and #338 are already merged. They intentionally delivered a dormant
procurement/custody checkpoint, not a completed financial integration.

1. `INVENTORY_INTEGRATION_ENABLED` must equal the exact string `true`. With it
   absent, new pages and the API are disabled; legacy inventory remains usable.
2. The 19 procurement tables and 10 custody tables remain unnumbered proposal SQL.
   Normal application migrations do not create them. They are installed explicitly
   only in disposable test fixtures. Setting the flag alone does not install them.
3. Unit versions, locations and approval policy are explicit reference data. No
   reviewed operational seed/setup workflow currently establishes them.
4. `invoice.match` records three-way matching, not a supplier payable or payment.
   Its response truthfully says `pending_shared_finance_review`.
5. Legacy manual issue and visit-signing material deduction do not allocate lots,
   while custody assumes complete lot/location allocation. They cannot safely run
   as independent stock writers after activation.
6. Patient-cost and commission readers do not yet consume the verified custody
   attribution and cost-completeness evidence. Connecting just the identifiers
   would expose pending valuation as a known zero or inherited historical WAC.

The existing 155 focused domain/rollout tests and 36 PostgreSQL procurement/custody
tests passed on this baseline. That is checkpoint evidence, not activation proof.

## Safety repairs in this slice

### Held quarantine capacity

Direct receipt into a doctor's custody is already an explicitly tested source
workflow; this patch does not prohibit it or invent a new receiving policy.

Previously a lot became eligible after any partial release, but usage checked the
full location balance. Receiving 100 held units and releasing 10 could therefore
permit consumption, return or independently approved waste above 10. Quarantine
could subsequently dispose the same held quantity again.

The writer now shares the dispatch capacity rule: physical balance minus the
unreleased quantity at the original receipt location. All custody usage kinds
respect that reserve. Expiry eligibility remains required for consumption/return;
approved waste of previously released expired stock is not newly prohibited.
Quarantine disposal owns disposal of held stock. Lot capacity is reread after the
shared item lock so a concurrent disposition cannot leave a stale capacity check.
Quarantine commands acquire item before lot, matching custody allocation FK
locking. Waste locks its approval exclusively but its approver only in SHARE mode,
retaining live authorization checks without an actor/item lock inversion.

The same already-loaded balance rows must prove that the receipt origin still
contains the reserve, even when reading or issuing at another location. A zero
or missing origin fails closed; no additional SQL, balance correction or evidence
rewrite is introduced. Synthetic pre-fix-shaped escaped-stock history stays
unchanged and is refused, not repaired. An activation integrity preflight must
still inspect all origins, including lots absent from normal positive-balance
views, and require separately reviewed remediation for any mismatch.

The existing custody layout now distinguishes physical quantity, available issue
quantity and held quantity. Its read uses one repeatable-read snapshot. No quote
is promoted to final cost, and doctors receive no new financial fields.

### Source allocation completeness

Equal net clinic and allocated balances were insufficient: unallocated +10/-10
could cancel. Each movement must now be fully allocated by absolute quantity and
each allocation's lot must belong to the movement's item, in addition to net
equality. Both the movement owner and the destination-lot owner are checked: a
one-way movement from item B allocated to item A must also invalidate item A. Incomplete evidence is shown as unavailable and blocks new custody
writes. This patch does not invent missing historical allocations.

## Local evidence for this dormant slice

- 14 real-PostgreSQL boundary cases pass, together with all 36 existing
  procurement/custody cases (50 total).
- 160 focused domain, rollout and quantity-presentation tests pass.
- Negative controls reproduce over-spending held stock, cancelling incomplete
  allocations, one-way foreign-item allocations, both actual 40P01 deadlocks and
  escaped reserve advertising. Fixes are not retry/timeout workarounds.
- Forced lock barriers prove consumption/disposal and independently approved
  waste/disposal complete while conserving the whole balance.
- Released expired stock remains eligible for independently approved waste, not
  patient consumption or valid-store return.
- No test establishes a completed financial adapter, browser workflow, deployed
  readiness, business-policy approval or permission to enable the flag.

## Coordinated adapters required before activation

### A. One stock issue path

Route legacy manual issue and automatic service-material deduction through one
transaction-owned adapter for tracked stock. Keep gate-off legacy behavior
unchanged. The adapter must receive a verified location/responsible doctor,
immutable conversion, valid lot allocation, clinical attribution and stable actual
usage identity. Lock item IDs in sorted order; write movement, allocations, usage
evidence and mandatory audit in the same transaction.

Until this exists, legacy writers must not change an already tracked item's
quantity. A temporary controlled refusal is safer than choosing an arbitrary
doctor/store or allowing quarantine bypass. Automatic signing refusal must roll
back its invoice, signing and every partial stock effect.

The unresolved operational choice is how a manually recorded actual use satisfies
or adjusts the configured automatic service-material requirement. It must not be
inferred from equal quantity, patient or reason. Those may identify two real uses.

### B. Verified clinical linkage plus truthful cost

`recordCustodyUsage` already resolves and verifies patient, visit, case and
procedure. The eventual movement adapter must copy only those verified IDs:
case-only means patient with no invented visit; procedure-only can use its verified
linked visit; waste has no clinical attribution. Do not ship that linkage alone.

The paired cost reader must examine completeness immediately before each issue,
not after an exhausting issue resets empty stock to a known state. Missing or
estimated base valuation/quantity is not an insertable known zero. Preserve
known explicit zero, currency-specific values and permission masking. A supplier
SAR/USD quote must never be copied into a YER unit-cost column.

Unverified material cost must not silently become an automatic commission or
payroll deduction. The approved material allowance policy and an actual-cost
reconciliation remain separate. Annual settlement remains provisional until
authoritative posted deductions, reversals and attributable costs exist.

### C. Invoice approval, supplier payable and payment

The existing debt source remains `payables`; existing settlement sources remain
expenses/payment allocations. Do not add another debt ledger.

`createPayable` currently uses independent pool queries and is not safe to call
inside `inventoryOperation`. Extract/reuse a transaction-aware writer with one
caller-owned transaction rather than nesting transactions or letting one half
commit. The invoice approval command must lock the exact invoice/order evidence,
require a fully matched approved valuation, create one native-currency payable,
insert the existing `supplier_invoice_payable_links` row, audit and persist its
idempotent result atomically. Receipt ingestion must never create that payable
again and invoice approval must never add stock again.

Reuse `recordExpenseInTx` and `voidExpenseInTx` for authorized payment/reversal;
retain existing native-currency, exchange-quote, overpayment, shift and audit
guards. `adjustPartyOpeningPayable` is an opening-balance correction, not an
operational supplier-credit-note adapter. Do not repurpose it for cancelling a
purchase debt. Operational invoice cancellation/credit and received-stock return
need source-linked compensating records, not deletion of posted evidence.

`needs_review` supplier invoices are currently append-only and their duplicate key
is already reserved. A reviewed revision/resolution lifecycle is necessary before
users can correct an invoice and rematch it. Do not evade this by changing its
number, generating another debt or relaxing duplicate detection.

### D. Durable command recovery

The procurement/custody hook preserves uncertain commands only while mounted.
A browser reload loses its exact key/payload, unlike the already implemented
legacy direct-purchase journal. Introduce a separate actor-scoped durable journal
with persisted-before-send reservation, immutable payload identity, matching
server acknowledgement and stale-principal protection. Retain the command across
timeout, lost response, reload and another tab. Do not deduplicate real uses by
similar content. Never automatically replay a command under another actor.

### E. Schema, master data and acceptance

The current candidate ends at 0069; other appointment branches reserve 0070–0072.
Recheck current repository/PR ownership with the release owner before assigning
any migration number. The proposals comprise:

- 3 master/reference tables: locations, unit versions and approval policies.
- 4 request/revision/approval tables.
- 3 order/source-allocation tables.
- 5 receipt/lot/movement-allocation/quarantine tables.
- 3 supplier-invoice/matching/payable-link tables.
- 1 durable server operation ledger.
- 4 custody transfer/acknowledgement tables.
- 6 waste/usage/stocktake/package/settlement/objection tables.

Review constraints, immutable guards, indexes and ownership together with the
adapters. Table presence alone is not a schema-contract proof. Do not apply the
proposal SQL ad hoc to a deployed database. Rehearse additive upgrade and approved
recovery on synthetic data, proving historical quantities/debts unchanged.

Reference-data decisions requiring explicit owner confirmation include actual
package conversions, accountable locations/doctors, approval limits/self-approval
exceptions, valuation/shipping/tax/FX treatment and cancellation ownership. Do not
seed test policies or infer payroll/disciplinary deductions from custody variance.

## Acceptance matrix for the next release candidate

- Gate off: all current inventory and signing flows remain compatible; no proposal
  table access, procurement writes or new navigation.
- Gate on, registered schema only: explicit readiness failure, no partial effects.
- Reviewed schema/reference data: request → independent approval → order → partial
  and final receipts → quarantine release/return/disposal → invoice revision/match
  → explicit payable → payment/reversal and source-linked cancellation.
- YER, SAR and USD remain separate; exact package/unit conversion and sub-minor
  costing are retained. No mixed-currency balance or quote-as-known-cost.
- Races, changed payloads, retries, committed response loss, reload, role changes,
  revoked users and stale revisions produce one committed effect or no effect.
- Doctor transfer/acceptance, actual consumption, unused return, clinical return,
  monthly custody count and annual review remain distinct operations.
- Unknown cost/lineage fails explicitly, and no stock movement automatically
  creates disciplinary debt or a new salary deduction.
- Built HTTP and hosted browser checks, independent review and owner Staging
  acceptance are required before any separately authorized Production release.

Local Chromium launch is blocked in this execution environment. No browser,
screenshot, deployed-runtime or complete end-to-end activation pass is claimed.
