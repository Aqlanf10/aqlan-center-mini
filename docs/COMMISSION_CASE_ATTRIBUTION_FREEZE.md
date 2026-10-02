# Preserve billed case attribution

## Verified defect and scope

The commission report derives a source procedure's case from the current plan
item. Changing that association after billing could therefore change historical
commission without changing an invoice, payment, override, or rate-history row.

A synthetic canonical workflow signs a 10,000 YER plan item for case A (20%),
receives 6,000 and 4,000, and refunds 2,000 against the first receipt. Before the
fix, relinking it to case B (50%) changed accrued commission from 2,000 to 5,000
and earned commission from 1,600 to 4,000. Removing the association changed them
to 3,000 and 2,400 at the ordinary 30% rate. The pre-refund cutoff changed too.
No real Production impact has been established.

## Narrow containment

- `setPlanItemCase` retains its existing `plan_items` row lock
- Only an actual change in `case_id`, including to/from NULL, performs a fresh
  statement checking `invoice_items.source_type = 'visit_procedure'` through
  `visit_procedures.plan_item_id`
- Any retained source line locks its attribution, including zero-valued,
  cancelled, or fully refunded invoices. Payment and item lifecycle status are
  not substitutes for that evidence
- The fresh statement is required after a lock wait, so an invoice committed by
  a concurrent signature is visible. No reverse-order visit lock is introduced
- Refusal rolls back the complete operation, including a requested priority
  change, and writes no successful `plan.item_case` audit
- The API returns HTTP 409 with an Arabic explanation. The existing patient-case
  UI already displays the server's error message
- Same-case priority/idempotent edits, unsigned drafts, and included installment
  sessions without a billed procedure source remain editable. Installment lines
  derive their plan from `invoices.plan_id`; case relinking does not reprice them

This is prospective containment only. It does not reconstruct already altered
links or change historical documents, rate rules, schema, or stored amounts.

## Regression coverage and verification

`__tests__/postgres/commission-case-attribution-freeze.test.ts` uses actual plan,
case, consent, signing, receipt/refund, installment, commission aggregate/detail,
and case-route services. Only the route's session is stubbed. Synthetic event
timestamps are fixed for deterministic historical-cutoff checks.

The suite covers unpaid A→B/A→NULL/NULL→B changes and paid/refunded
A→B/A→NULL changes, partial on-start billing, zero-value source lines, retained cancelled/refunded history, stale
legacy lifecycle markers, same-case/NULL priorities, draft and included-session
positives, doctor/admin HTTP conflicts, and both lock orderings. Test-only
advisory-gated triggers plus an independent `pg_stat_activity` observer prove
actual concurrent contention. Gates and connections are released in `finally`.

Baseline before the guard: 12 intended containment failures and 5 passing
positive cases on isolated PostgreSQL 18.4 (UTF8/UTC). An additional unchanged
NULL-case positive was then added. The final focused run passed 75/75 PostgreSQL
tests, including all 18 new cases plus the existing commission, specialty-case and
installment-inclusion suites. Independent runtime review found no code blocker and reran all 18 new cases
plus the 49-case PostgreSQL baseline (67/67); 43/43 pure commission tests also
passed independently. Final exact-head CI, merge and Production verification
remain pending.
