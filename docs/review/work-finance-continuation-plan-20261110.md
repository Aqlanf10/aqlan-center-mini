# Finance continuation: plan, results and resume point

Branch `feat/claude-work-continuation-20261110` (independent; stacked on the #506 head `8586f991`). This file is the resume point: update it at each step so the work can be picked up by any session.

## Rules in force

- Synthetic data only (`SYN-` prefix). No Production or Staging access, no deployment, no merge into `main`, WORK (#506) or any orthodontic branch.
- Dot owns orthodontics and cephalometry (#530, `feat/ortho-reconcile-20261109`, #532, #533). Do not edit those branches, the ortho/ceph files, or the test files those PRs touch. If a finance fix needs a shared file, record the overlap in section 4 and continue with independent work.
- Every fix: a test that fails without it, grants and patient scope preserved, money in integer minor units per currency, audit in the same transaction.
- One writer at a time in `lib/db.ts`. Review agents are read-only; their reports are leads, not evidence — each claim is re-verified in the code and by a test before it is acted on.
- Never run two PostgreSQL test runs at the same time on the local instance.

## 1. Done on this branch

| Commit | Content | Evidence |
|---|---|---|
| `aae4d721`, `8417afdb`, `44e85d1f` | Interim branch: plan-item financial-lineage privacy fix (Dot's P2 on #506) | Executed here for the first time: 8/8 with the fix; the new test fails with the fix reverted. |
| `4b3b2187` | Slice 95a: historical onboarding reads | PG 4/4 |
| `4424b90b` | Slice 95b: pre-system treatments | PG 5/5 |
| `817106ac` | Slice 95c: historical documents | PG 6/6, two mutations, related PG 837/837 |
| (slice 95d commit) | Slice 95d: previous-balance arrangement; regenerated `inventory.json` | PG 4/4, two mutations, related PG 273/273 |

Gate finding on `817106ac`: the interim commits had not regenerated `docs/security/staff-cutover/inventory.json`; the readiness audit reported drift (2 unit failures). The regenerated file is committed with slice 95d. One more unit failure (`redirect-hardening`, a 5 s timeout under load) passes alone.

## 2. In progress

- Slice 95d: committed. PG 4/4, two mutations fail as required, related PG 273/273, unit 175/175, audits 10/10.
- Full gate on the new head (unit, tsc, lint, audits, PG list, build, HTTP journeys), then push and open a Draft PR against the #506 branch (review only).

## 3. Finance queue (order by risk to patient balances and the cash box)

Three read-only audits were started on 2026-11-10, one per area. Their findings are listed here only after I have verified them.

| # | Area | State |
|---|---|---|
| F1 | Shifts, cash box, treasury: balance arithmetic, concurrency, grants | audit running |
| F2 | Expenses and payables: links to lab orders and treasury, void and edit | audit running |
| F3 | Commissions and reports: doctor share, payout, report vs ledger | audit running |
| F4 | Independent security review of the completed diff | after F1–F3 fixes |

Verified findings and their fixes:

_(none yet — fill in as each is confirmed: id, file and lines, scenario, failing test, fix commit)_

Canonical conversion still open in finance (from the route map): shifts and day close, expenses, treasury, payables, commissions, reports (29 methods). Confirmed defects are fixed first; conversion slices 96–98 follow in that order.

## 4. Overlaps with Dot's work

- None needed so far. `lib/db.ts` is shared with #530 only in the sense that both lines change it in different sections; finance fixes stay out of the ceph and ortho sections.
- Integration plan: `work-continuation-status-and-ortho-integration-plan-20261110.md`. Nothing is ported until Dot names a frozen head.

## 5. Open decisions for the owner

- Policy points 1–9 of contract section 15 (recommended defaults are implemented; the owner may change them).
- Correction price controls (93c). Financial responsibility for a case (G4-7).

## 6. How to resume

1. `git fetch origin feat/claude-work-continuation-20261110` and check the head against section 1.
2. Read section 2 for the step in flight, then section 3 for the next finding.
3. Local PostgreSQL 18 on port 54329; one PG run at a time. Gate scripts: unit + tsc + lint + audits, then the PG list, then build + HTTP journeys.
