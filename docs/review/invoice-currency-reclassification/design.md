# Invoice currency correction: append-only settlement reclassification

Implementation is on the single continuation branch
`fix/invoice-currency-reclassification`, based on merged main
`482cbed4a434407514cdf73221e96cde7aaaadbb`. PR343 contains the merged phase1;
the original local branch is preserved. Migration0063 was explicitly allocated
by the parent after checking remote branches. HR0062/PR342 are excluded.
No production correction or migration has been performed. Parent reserves merge
and deployment; continuation publication requires the agreed verification gate.

## Supported boundary

An admin may correct a YER invoice to SAR, including an issued, partially paid
invoice. Every receipt in its authoritative correction lineage must prove its
patient/invoice, original SAR amount, recorded YER amount, original FX arithmetic
and refund origin. The writer uses each recorded SAR amount; no current exchange
rate, aggregate division, unallocated balance or guessed currency is used.

Missing, ambiguous, mismatched, duplicate or incomplete evidence fails closed.
Other currency transitions, legacy agreements and independent financial source
types are unsupported. All treatment items and quantities must remain. Clinical
identity changes cannot be combined with currency correction. Per-procedure
plans must belong to the patient and be wholly covered by this invoice lineage;
shared plans, extra unbilled items and installment agreements are rejected. The
writer preserves plan-item, case and visit IDs and stores the new currency/prices
only for the fully owned plan. It creates no duplicate clinical treatment.

The original invoice's accounting period must be open. An affected doctor's paid
commission expense blocks correction. Any non-reversed payroll item carrying
commission also blocks it; this first-release guard is deliberately conservative
and may reject an unrelated doctor's correction. No paid/approved commission is
silently reinterpreted. A broader policy needs a separate explicit adjustment.

## Persisted evidence and transaction

Migration0063 adds `original_currency` to invoice corrections and two immutable
tables: `invoice_settlement_reclassifications` and its per-payment `..._events`.
One document belongs to one correction and the exact sorted source lineage.
Each event records direction, source/target minor units and the complete original
payment row snapshot. Insert guards verify ownership, currency, linkage, snapshot
and recorded FX. Deferred constraints prove complete coverage before commit.
Mutation/destructive operations fail; the existing authorized full-clinic reset
is separate. Runtime initialization registers the exact checksum and does not
reinstall0061's same-currency guard over its successor.

The canonical correction writer retains the source invoice, cancels/replaces it,
records the target currency, writes evidence and an immutable acknowledgment,
and revises repayment terms in one transaction. It locks commission/payroll
writers before patient/receipt/shift resources, takes receipt KEY SHARE fences
before shift locks, and verifies the receipt set again after waiting. This avoids
the reproduced receipt-refund/FK/shift deadlock. Source hash and authority are
rechecked; a new receipt requires a fresh preview. The idempotency key binds the
body, original invoice and actor. Replay returns the stored acknowledgment.

Original receipt IDs, numbers, amounts, currencies, FX, timestamps and cash
entries remain unchanged. A later refund appends exactly one negative event.
Receipt correction reverses the original receipt and routes its replacement to
the active SAR invoice. Replaying an earlier correction still resolves the saved
lineage acknowledgment after another invoice correction.

## Example and ledger

Synthetic source invoice2500YER becomes2500SAR. Receipts are700/100/100SAR,
with recorded YER287000/41000/41000 at410. The target settles900SAR and owes
1600SAR. An unallocated100YER remains an independent credit.

For each receipt, append balanced noncash legs (table below aggregates the three
for readability; stored evidence remains per receipt). Amounts are minor units:

| Currency | Account | Debit | Credit |
| --- | --- | ---: | ---: |
| YER | 1201 patient receivable | 369000 | 0 |
| YER | 1901 FX clearing | 0 | 369000 |
| SAR | 1901 FX clearing | 90000 | 0 |
| SAR | 1201 patient receivable | 0 | 90000 |

The original YER invoice issue remains in journal history. A dated reversal of
that invoice and the new SAR invoice issue accompany the settlement adjustment.
Cash/bank accounts are absent from reclassification entries. Refund entries
reverse their own recorded source/target amounts once. Per-receipt rounding may
leave a signed YER rounding residue after full native-currency refunds; the
implementation reverses the stored figures, never recomputes an aggregate.

## Read models and commissions

The evidence adapter verifies immutable snapshots, full lineage coverage and
terminal target ownership/currency. Settlement/account/debt/repayment/checkout,
clinical financial summaries, portal, print and reports consume an allocation
projection while retaining the original cash facts. The general ledger uses the
same verified evidence. Historical report cutoffs before correction retain the
original invoice/settlement currency; current totals use the corrected currency.
Print retains the original paid amount/FX and labels the corrected settlement.

Unpaid commissions retain the original invoice and receipt policy timestamps,
including microsecond ordering. The new invoice's calendar date still controls
report recognition. Proven allocations reserve their target invoice before
legacy FIFO, so another SAR invoice cannot take the corrected settlement or its
commission. Refunds reduce the original covered part; fixed/invoiced policies
retain their established behavior. The tests change a doctor's policy30%→60%
between receipt and correction and add an unrelated SAR invoice: the corrected
receipt still uses30%, and does not earn on the unrelated invoice.

PostgreSQL monetary projections use one repeatable-read read-only snapshot for
invoice/receipt/evidence inputs. Commission helper reads use the same connection
to avoid pool starvation under concurrent reports. A failed rollback destroys
the connection while preserving the original error. PGlite is detected from its
actual initialized adapter, not a mutable environment flag; its shared executor
keeps the existing transaction-free read behavior without a concurrency-isolation
guarantee. Parent snapshot work is integrated and tested with the extra evidence
queries. The parent's PR344 cutoff patch is preserved in reports.

## Durable command recovery

The recovery button explicitly POSTs the saved financial request; it is not a
read-only status check. Blocked, busy, null, refusal and uncertain outcomes have
visible explanations. A later refusal does not erase a potentially committed
command. No automatic resend, key rotation, journal deletion, timeout unlock or
unlock based on an absent server record was added. Lost-response tests reload
the page and explicitly retry the exact saved body/key to retrieve one result.

## Verification and deployment boundary

Use phase2 verification evidence for this implementation; the earlier
`verification.md` describes phase1 only. Full PostgreSQL, money/receipt/commission
regressions, build/typecheck/lint and built HTTP/Arabic390/1280 checks are required.
Unit tests alone do not establish readiness. Only synthetic local databases and
browser fixtures are used; stopped staging stays stopped. Parent review, push,
CI, merge and deployment remain outside this delegation's current permission.
