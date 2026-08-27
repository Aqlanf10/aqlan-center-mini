# Ordered implementation roadmap

This roadmap is the development gate for `feat/mvp-v1`. Work must not jump to a later phase while an earlier financial invariant is failing.

Technical-debt controls in `docs/TECHNICAL_DEBT_GUARDRAILS.md` apply to every phase. Passing a functional test does not waive an architectural or migration guardrail.

## Phase 0 — ledger correctness (implemented; full gate passed locally)

- Make patient-receipt reversal append-only.
- Make voucher reversal atomic and unique under concurrency.
- Make commission payout, status and audit atomic; allow only one active payout.
- Add migration `0007` without editing applied migration `0006`.
- Prove patient, cash-account, report and collected-commission outcomes with real PostgreSQL tests.

Exit criteria:

- Original payment remains unchanged.
- Reversal payment is a separate row linked to the reversal voucher.
- Original plus reversal payment sums to zero.
- Exactly one concurrent reversal succeeds.
- Exactly one concurrent commission payout succeeds; a same-key retry is idempotent.
- Reversing a commission payment re-opens the commission for deliberate repayment.
- Upgrade succeeds from both an empty database and a schema already at `0006`.

## Phase 1 — workflow reconciliation (navigation implemented; browser acceptance pending deployment)

- Implement the task-oriented navigation defined in `docs/INFORMATION_ARCHITECTURE.md`.
- Exercise Patient → Appointment → Arrival → Visit → Work items → Complete → Next appointment → Follow-up.
- Remove duplicated calculations and dead controls discovered by the walkthrough.
- Confirm mobile Arabic RTL and English LTR behaviour.

Exit criteria: browser acceptance evidence, no 5xx, and persisted state after a new login session.

## Phase 2 — billing decision

- Write an ADR for explicit invoices versus the existing charge ledger.
- If approved, add invoices additively and link them to services/work items without changing historical charges.
- Specify allocation of partial payments and refunds before implementing collection-based commissions.

Exit criteria: one documented patient-balance formula and reconciliation tests for legacy and new data.

## Phase 3 — cashier controls

- Write an ADR for mandatory cashier sessions, opening counts and per-currency closing counts.
- Add shifts only if approved; never allow an untracked alternate cash total.
- Add exchange-rate snapshots only if the owner requests base-currency reporting.

Exit criteria: native-currency closing reconciles to voucher movements and counted cash for each account.

## Phase 4 — accounting

- Define a chart of accounts, journal derivation rules and accounting period locks.
- Decide whether journals are derived or persisted; document reconciliation and correction behaviour.
- Implement only after the operational subledgers are stable.

Exit criteria: balanced entries, trial balance, income statement and balance sheet backed by integration tests.

## Phase 5 — owner-readiness

- Validate all print formats, export/backup runbooks, responsive layouts and production error logs.
- Remove or archive test records only through audited owner-approved procedures.
- Merge PR #1 only after review approval and successful gates.

## Gate required for every phase

```text
npm run typecheck
npm run lint
npm test
npm run build
```

Every delivery reports the new SHA, migration impact, test counts, unresolved owner decisions and confirmation that `main` and Railway production were not changed.
