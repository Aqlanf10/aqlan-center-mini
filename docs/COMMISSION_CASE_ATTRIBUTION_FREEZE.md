# Preserve billed and signed clinical case attribution

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

- `setPlanItemCase` locks patient, plan, then item. Target Ortho and clinical
  case rows are locked before validation and retained through the write
- Only actual changes in `case_id`, including to/from NULL, invoke identity
  guards. Existing invoice lineage (direct item source, `plan_item_id`, or
  procedure source) and historical treatment agreements remain frozen
- Any retained invoice source line locks attribution, including zero-valued,
  cancelled, or fully refunded invoices. Payment/item lifecycle alone cannot
  replace that evidence
- Independently, any signed visit reached through a procedure, treatment session,
  or legacy item `visit_id` freezes clinical attribution. Included installment,
  waived and zero-due signed work is protected even without an invoice source
- Evidence is read in fresh statements after the patient serialization lock, so
  a concurrent committed signature is visible. No reverse-order visit lock is added
- New attribution must match patient, catalog specialty, exact authoritative
  scope and open case/Ortho lifecycle. Closed items/plans cannot be reassigned
- Arch and multi-tooth scope is not persisted authoritatively on plan items.
  Ambiguous changes return `scope_unknown`; free text and the new target cannot
  supply the missing authority. No migration/backfill or historical repair occurs
- Refusal rolls back the complete operation, including requested priority,
  and writes no successful `plan.item_case` audit
- HTTP 409 includes a specific Arabic explanation, displayed by the existing UI
- Same-case priority/idempotent edits remain available, including signed or
  historical work. Compatible unsigned draft links remain editable

Installment financial allocation still derives from `invoices.plan_id`. This
clinical freeze does not reprice installments, change commissions or alter FIFO.

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
positives before the P1 extension, doctor/admin HTTP conflicts, and both lock orderings. Test-only
advisory-gated triggers plus an independent `pg_stat_activity` observer prove
actual concurrent contention. Gates and connections are released in `finally`.

Historical verification of the earlier invoice-only guard (not verification of the P1 extension below): 12 intended containment failures and 5 passing
positive cases on isolated PostgreSQL 18.4 (UTF8/UTC). An additional unchanged
NULL-case positive was then added. The final focused run passed 75/75 PostgreSQL
tests, including all 18 new cases plus the existing commission, specialty-case and
installment-inclusion suites. Independent runtime review found no code blocker and reran all 18 new cases
plus the 49-case PostgreSQL baseline (67/67); 43/43 pure commission tests also
passed independently. Final exact-head CI, merge and Production verification
remain pending.

## P1 clinical identity extension: verification pending

The old positive assertions allowing SIGNED included-session relinking are
intentionally superseded by `signed_case_lock`. The source regression adds each
execution edge, initially unassigned signed work, compatible draft edits and
same-case priority, exact specialty/tooth/lifecycle refusals and no-write checks.
`clinical-case-identity.test.ts` adds real-writer PostgreSQL closure/link and
closure/Endo-open races with observed backend blocking edges. Pure tests compare
the shared adapter against the canonical invoice site matcher. HTTP fixtures
exercise server-authoritative refusals and patient/role boundaries.

This extension has only been prepared and reviewed as source. No local app,
SQL, builds or tests were run. Red/green execution, full exact-head CI and
isolated real PostgreSQL/HTTP acceptance remain required before release.

### Merge-safe authorization boundary

The case-link and case-status routes carry the patient they actually authorized
as `expectedPatientId`. The stores refuse stale ownership, a vanished patient
lock row, and post-lock owner changes before any write or same-case priority
shortcut. They do not authorize or lock a newly discovered merge target late.
Generic closure returns its canonical DTO captured inside the locked transaction.
Source regressions include actual merge writers and stale-route owner contracts;
execution remains pending.
