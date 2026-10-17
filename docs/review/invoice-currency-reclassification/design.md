# Invoice currency correction: blocked integration design

Status: **not implemented end to end; do not deploy as a currency fix**.
Base: main `4f65b60793db94c1ca8c8a52a32acd83d666c5fb`.
Proposed migration number: **0063, pending owner approval**. No migration file,
registration, runtime schema change or live data action is included. 0062 HR is
unapproved and must not be reused. PR342 is outside this branch.

## Supported boundary proposed for the first release

Correct YER invoices to SAR (or USD only after equivalent integration tests) when
all allocated receipts are explicitly linked to the invoice's authoritative
correction lineage and their original currency is the requested currency. Each
receipt must carry valid original minor units, recorded YER minor units, rate,
patient and invoice identity. No inference from a patient's other receipts, no
current FX, and no division of an aggregate. Refuse missing, duplicate, mismatched,
legacy-note-only, cyclic or incomplete evidence. The arithmetic prototype is NOT
an authorization, ownership, completeness or concurrency check.

Preserve the plan-item, clinical-case and visit IDs. Initially refuse any plan
whose complete pricing/coverage is not exclusively owned by this invoice lineage:
other billed invoices, unbilled/priced items, installment agreements, historical
agreements or shared cases need explicit policy. Do not merely update a shared
plan's currency. Exclusively owned plans need a complete price snapshot in both
currencies and the approved-work coverage guard must consume it. Reject identity,
quantity and currency changes combined in the same operation initially.

Reject corrections touching paid/locked commission statements until an explicit
append-only commission adjustment policy exists. For unpaid commissions, preserve
the original event attribution/rate and append the difference; do not recalculate
history using today's commission rules. Accounting-period authority must be
revalidated inside the transaction; rejecting a closed original period is the
initial policy. The UI must show exact unsupported reasons before confirmation.

## Proposed evidence and transaction

Retain the original invoice, receipt numbers, cash, amounts, currencies, FX and
receipt timestamps. Cancel/replace the invoice through the existing correction
writer with a documented target currency and the exact approved treatment IDs.

Add a parent reclassification document tied uniquely to the correction, patient,
source and target currencies, original/current invoices, request hash, actor,
reason, recorded timestamp and immutable acknowledgment. Add immutable event rows
with unique (reclassification, payment) identity, kind/direction, original receipt
and reversal identity, recorded source and target minor units, and a complete
receipt snapshot. Use foreign keys and insert guards for ownership, linkage,
currency and snapshot equality. Updates/deletes fail closed (respect only the
existing authorized whole-patient deletion semantics). A deferred constraint must
prove complete coverage plus acknowledgment before commit. Plain foreign keys do
not prove complete receipt coverage.

Take the existing patient -> shift -> visit -> plan/case -> invoice/debt locks;
re-read source proof after waiting. All receipt/refund/correction writers must
participate in the same patient fence. Keep request key/body/actor fingerprint and
immutable acknowledgment in the same transaction. A replay returns the exact
receipt, and a different body/actor/key combination fails. The final source proof
must include reclassification events, refunds, commission locks, plan ownership,
coverage and repayment versions. Authority is checked before replay and commit.

Cancel/revise old repayment terms append-only and create target-currency terms
from the corrected remainder. Preserve schedule provenance; never convert prior
installment amounts in place. A rollback at any insert must leave no replacement,
plan edit, partial evidence, revised schedule or cash effect.

## Arithmetic and journal entries

Synthetic input: original 2500 YER, corrected principal 250000 SAR minor units.
Receipts have SAR minor units 70000, 10000, 10000 and recorded YER units 287000,
41000, 41000. Net original settlement is 369000 YER, target settlement is 90000
SAR minor units, remainder is 160000 SAR minor units. The unrelated unallocated
100 YER remains an independent credit.

For the correction-date reclassification, derive non-cash general-ledger lines:

| Currency | Account | Debit | Credit |
| --- | --- | ---: | ---: |
| YER | 1201 patient receivable | 369000 | 0 |
| YER | 1901 FX clearing | 0 | 369000 |
| SAR | 1901 FX clearing | 90000 | 0 |
| SAR | 1201 patient receivable | 0 | 90000 |

Amounts above are minor units. Each currency balances independently. Do not emit
cash/bank lines. These lines are additional dated evidence; historical receipt
entries retain the original YER allocation and SAR cash. Invoice cancel/replace
entries remain separately traceable. Do not count a derived settlement override
and these adjustment entries twice in a single report.

Refunds already present are subtracted individually from their original receipt's
recorded amounts, validating reversal identity and cumulative bounds. After a
reclassification, each new partial/full refund needs an additional signed
reclassification event in its own transaction. Its cash refund remains exactly
one original-currency cash movement. Receipt correction must reverse the remaining
original allocation once and allocate the replacement once through the effective
current invoice; unsupported currency/target changes are refused. Unique event
keys and bounds guard duplicate and concurrent refunds. None of these future
writer integrations is implemented by the arithmetic prototype.

## Required integration map (all still blocked)

- `invoice-correction-schema.ts`, migration 0061 successor and runtime schema:
  replace same-currency constraints with *proven* source/target constraints, never
  simply delete the guards; update schema contract/ownership/restore manifests.
- `invoice-revision-db.ts`, `correctInvoiceInTransaction`, `InvoiceCorrection`:
  target minor-unit parsing, preview proof, ownership/commission checks, replacement,
  evidence/ack write and source-aware restored receipt validation.
- `invoice-settlement-lineage.ts`, `invoice-settlement-position.ts`: follow the
  documented mixed-currency lineage, consume each event once, reject missing proof.
- `debt-account-position.ts`, `money.ts`, `patientLedgerInSnapshot`: add explicit
  per-currency settlement deltas while leaving receipt presentation historical.
- `db.ts` commission/debt/report/portal reads and accounting readers: use the same
  effective allocation evidence, with dated general-ledger adjustment entries.
- Exit/checkout, invoice print, portal, reports and installments: assert agreement
  with canonical invoice and patient positions in HTTP and database tests.
- Refund/correction writers: fence against invoice changes and append reversal
  allocation evidence exactly once. No financial mutation may bypass this fence.
- Backup/restore: preserve evidence, triggers, identities and acknowledgments, then
  compare all financial positions and ledger balance after restore.

## Recovery delivered separately

The recovery button still performs an explicit POST with the saved body/key. The
screen now states that fact and explains why invoice correction is blocked. It
shows blocked/busy/null/refused/uncertain outcomes and retains a later 4xx reason
without retiring a possibly committed command. No automatic replay, key rotation,
IndexedDB deletion, unlock on timeout or unlock on missing server record exists.

A future read-only resolution endpoint must bind operation, endpoint/body hash,
key, actor and patient to the stored acknowledgment. A missing row remains
uncertain. To certify non-execution, a terminal rejection/fence has to share the
writer's serialization lock and prevent a late request from committing. This
branch introduces no endpoint that falsely treats absence as failure.

## Acceptance still required before release

Full paid synthetic scenario across every reader and writer; immutable cash and
receipts; unrelated 100 YER; exact minor units and per-receipt rounding; repeated
requests/lost acknowledgments; collect/refund/correct races; RBAC and period locks;
exclusive/shared-plan coverage and retained treatment IDs; paid commissions;
rollback injection and restore; all existing financial/commission tests; real
PostgreSQL 18; built HTTP and Arabic UI at 390/1280. Prototype unit tests alone
are explicitly insufficient. Recovery UI evidence does not establish currency
correction support.

## Separate approved-agreement debt contract (owner audit)

The owner reports an independently verified legacy behavior: `recordPlanInstallment`
(`lib/db.ts`, around 19998–20064 on this base) invoices only the collected installment,
then marks that invoice paid. `operational-agreement-summary.test.ts` explicitly
expects a 300 SAR agreement with 100 then 40 collected to retain agreement balances
200/160 while `balanceMinor` stays zero. `td05-currency-persistence.test.ts` expects
a 1500 USD plan with 500 collected to generate only a 500 invoice. This is a
pre-existing contract, not proof that reported patient records were deleted.

The newly requested contract is full outstanding **approved** obligation as debt,
with currently due installments shown separately. It needs its own approved
agreement migration, coverage of already-issued installment invoices, and proof
that opening principal is not billed twice. Never invoice every draft plan and
never add debt based on an unverified patient report. No change to that legacy
writer or live data is included here.

## Confirmed sequential-collection defect and narrow repair

PostgreSQL regression (three fresh keys on one 600 SAR schedule) failed before the
repair: one 200 SAR receipt was issued, `requiresReview` became true, and the next
two requests were rejected as stale. The final position incorrectly remained
400 SAR outstanding because the schedule's immutable source snapshot included
the original payment list. Ordinary collection changed that fingerprint.

`debt-source-proof.ts` now compares principal identity separately from settlement
extension. It preserves all source facts except the payment list and the current
invoice's derived open/paid status. Every baseline receipt must still exist with
identical canonical JSON. Only additional positive ordinary payment events with
no reversal reference are accepted. Any new refund, baseline mutation/removal,
changed principal/currency/lineage, or cancellation still requires review. The
existing complete request/preview `sourceHash` is unchanged, and no revision
snapshot is rewritten. Opening-balance snapshots keep their exact comparison
policy. Collection amount/account caps, actor checks, locks and replay checks are
unchanged. Both collection admission and `requiresReview` use the same predicate.

The new PostgreSQL tests pass for three fresh payments without another invoice or
revision; two concurrent payments whose sum fits the balance; overcollection
rejected specifically as invalid; partial/full refunds; receipt corrections;
principal changes and cancellation. The built Arabic workspace test now collects
three fresh keys at 390/1280 and checks `requiresReview=false` after each before
editing the remaining schedule. This fix needs no migration and no PR342 file.

Other owner-audited candidates are recorded but deliberately not changed here:
`computeDebtRows` uses independent pool reads rather than one consistent snapshot;
`lib/reports.ts` mixes an as-of balance with lifetime billed/paid aggregates. Their
implementation ownership is separate to avoid concurrent edits.
