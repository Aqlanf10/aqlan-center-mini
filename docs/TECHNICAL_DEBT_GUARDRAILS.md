# Technical-debt guardrails

The established system is a valuable workflow reference, but its repository also shows the cost of uncontrolled expansion: 166 migration-related files, runtime database hotfix machinery, overlapping finance generations/controllers, and very large startup/migration artifacts. This project must preserve the business lessons without repeating those structural problems.

## Non-negotiable guardrails

| Risk observed in the reference system | Guardrail in this project | Enforcement |
| --- | --- | --- |
| Runtime schema repair and swallowed startup hotfix failures | Schema changes run only through reviewed, immutable Drizzle migrations | `db:release`, migration integration tests, no DDL in application startup |
| Multiple finance generations and overlapping controllers | One treasury voucher domain and one patient subledger; no V2/V3 parallel implementations | `docs/SYSTEM_COMPARISON.md`, code review and shared domain queries |
| Very broad scope coupling clinical, AI, inventory, finance and messaging | Ship ordered phases and require an owner decision before scope expansion | `docs/IMPLEMENTATION_ROADMAP.md` |
| Duplicate sources of truth between documents and balances | Balances are derived from documented ledgers; mutations and audits share one transaction | PostgreSQL integration and reconciliation tests |
| Application-only concurrency checks added after incidents | Money and uniqueness invariants have database constraints plus concurrent tests from day one | Partial unique indexes, row locks/atomic claims and race tests |
| Large changes that are hard to review and reverse | Small commits per invariant, additive migrations and no edits to applied migrations | Git history and PR review |
| Historical corrections performed by mutation | Financial and completed-clinical corrections are append-only | Reversal/correction tables and audit records |
| Reports drifting from operational screens | Screen, print and export views call the same domain query | No page-local balance SQL |

## Change checklist

Before adding a table, route or server module, the implementer must answer:

1. Which existing domain owns this concept?
2. Is an existing table already the source of truth?
3. What invariant belongs in PostgreSQL rather than only TypeScript?
4. How does the change upgrade a database with every prior migration already applied?
5. What happens under duplicate submission and concurrent requests?
6. How is the action reversed without deleting history?
7. Which single query feeds the screen, print view and report?
8. What test proves legacy data retains the same balance?

If these answers are missing, implementation pauses at design rather than creating a second path.

## Debt budget and priority

Priority score uses `(impact + risk) × (6 - effort)`, each dimension scored 1–5.

| Item | Impact | Risk | Effort | Priority | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| Incorrect/non-atomic receipt reversal | 5 | 5 | 2 | 40 | Fix before all feature work |
| Commission payout and PAID state committed separately | 5 | 5 | 2 | 40 | Fixed: one transaction, idempotent retry and database uniqueness |
| `0006` delivered as a very large cross-domain migration | 4 | 4 | 4 | 16 | Never rewrite it; use small forward migrations beginning with `0007` |
| Patient billing has charges while work items are a separate value source | 4 | 5 | 4 | 18 | ADR before invoice automation |
| Treasury has no cashier-session control | 3 | 4 | 4 | 14 | Owner decision and design after ledger correctness |
| General ledger/accounting scope is undefined | 3 | 5 | 5 | 8 | Keep out of code until an approved accounting ADR exists |
| Overlapping `aqlan-center` repository | 4 | 4 | 1 | 40 | Freeze as reference; implement nowhere except this repository |

## Definition of done

A feature is not done because its page renders or its happy-path test passes. It is done only when:

- its source of truth and reversal rule are documented;
- database, server action, report and print output reconcile;
- duplicate and concurrent requests are tested;
- migration upgrade and rollback/recovery impact are known;
- authorization is checked server-side;
- typecheck, lint, unit/integration tests and production build pass;
- no second implementation of the same business rule was introduced.
