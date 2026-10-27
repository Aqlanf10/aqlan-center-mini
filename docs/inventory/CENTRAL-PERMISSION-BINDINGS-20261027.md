# Inventory integration requirements for the central authority owner

These are existing business operations and required decisions, **not new
capability names, roles or grants**. The canonical catalogue owner supplies the
exact centrally managed capability mapping. Missing mappings remain closed.
Legacy `admin` checks cannot serve as acceptance for an administration-configurable
module, including when a synthetic test injects a successful authority adapter.

| Product action / current command | Central decision and additional domain boundary |
|---|---|
| First-use reference read and count-only readiness | Inventory setup/report visibility; no patient details, financial amounts or activation grant from counts |
| Create material/base unit, add package conversion, create location | Configure inventory references; immutable prior conversions, active doctor linkage for custody locations, no stock/debt creation |
| Revise approval policy | Manage approval limits; optimistic version and audit; cannot enable self-approval through setup |
| `request.submit`, `request.revise` | Create/revise purchase requests with caller ownership and existing revision rules |
| `request.approve` | Approve within assigned amount/currency/scope limits; independent approver and current policy locked in the transaction |
| `order.issue`, `order.amend` | Issue/amend orders; preserve approved source commitments and receipt history |
| `receipt.post`, `quarantine.resolve` | Receive/inspect or resolve quarantine as separately governed actions; exact order version, available quantity and documented reason |
| `invoice.match`, supplier revision/post | Record/review supplier invoice and post one linked payable; exact source digest, saved currency/rate and no duplicate source |
| Existing supplier payable payment/expense reversal | Use the canonical finance/cashbox writer and its payment/reversal capabilities, active shift and financial limits; inventory cannot grant these rights or create another payment ledger |
| Supplier invoice cancellation / future partial credit | Reversal permission, source lineage and serialized payment/stock eligibility; full-paid/part-paid states cannot be treated as unpaid cancellation |
| `custody.dispatch`, `custody.acknowledge` | Issue and acknowledge separately; recipient/location scope and outstanding transfer quantities |
| `custody.consume`, `custody.return_to_store` | Record actual consumption or return unused issued quantity; assistant delegation and doctor/location scope; patient/visit write access additionally required when attributed |
| `custody.approve_waste`, stocktake, package closure | Govern waste approval and discrepancy evidence separately from ordinary consumption; no automatic financial charge |
| Stock adjustment / `legacy.reconcile` | Existing adjustment/reconciliation authority, source proof and audit; first-use setup never adopts unexplained legacy history |
| Custody settlement proposal/objection and doctor reports | Record/review observations and objections within scope; no doctor debt, salary/commission deduction or refund without an approved policy and writer |
| Patient material cost / inventory financial reports | Intersection of patient access and financial-cost/report permission, with recorded consumption evidence and missing-cost states; no cost inferred from service names |

The server projects permitted actions and a bounded explanation for UI controls.
It must recompute authority under the same transaction and locks that protect the
business write, including exact replay/retirement. A visible button, stale preview,
stored browser permission, old `admin` role or old admission is never a grant.
Tests must cover a delegated user allowed one action but denied an adjacent one,
revocation between preview and save, role/credential changes, self-approval,
limits, audit failure, payment/receipt concurrency and lost responses.

All current procurement/custody adapters still contain role-based checks; supplier
authentication additionally permits only a signed legacy administrator. These are
known integration limits, not completed permission work. They need a narrow
central authority adapter, not duplicated catalogue tables or a whole older branch
merge. The reference setup adapter is being prepared closed by default. Existing
financial journal command kinds and evidence must remain intact.

Account continuity and restore provenance are independent from action grants.
See [the recovery requirements](CANONICAL-RECOVERY-REQUIREMENTS-20261027.md).
An unchanged v1 locator (`realmId` plus numeric user ID) cannot authorize historical
pending execution or terminal adoption after restore. A central persistent subject
and reviewed lineage proof must bind historical evidence to the current session.
Source commands remain immutable and held while that proof is unavailable.

Exact deferred 0076 session/catalogue/restore sources and the local-only 0077
payable guard proposal are still unavailable in this executor after the two
supported archive download attempts failed. Native archive read returned no text.
The next dependency action is receipt of those exact source files through the
supported private text route, then composition tests; no further archive retry or
guessed equivalent implementation is authorized by this document.
