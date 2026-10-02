# Accounting report carry-forward

## Scope and contract

This repair changes read projections only. It does not change source documents,
amounts, posting configuration, schema, permissions, period locks, or mutations.
It cannot reconstruct historical settings snapshots: `journalEntries` continues
to derive the currently applicable source ledger, including its existing rules
for corrections and automatic posting. Cash-shift opening counts and manual cash
movements are separate reconciliation concerns, not resolved by this report fix.

`GET /api/accounting?from=...&to=...` reads the derived journal once, from
`0001-01-01` through the normalized inclusive end date. The pure projection then
returns:

- `balances`: unchanged selected-period debit/credit activity and natural-side net
- `cumulativeBalances`: all source activity through `to`, per account and currency
- `accountSummaries`: opening natural-side balance strictly before `from`, period
  debits and credits, and closing natural-side balance through `to`
- `statements[].income`: selected-period income only
- `statements[].sheet`: cumulative assets, liabilities, equity and accumulated
  earnings through `to`
- `entryCount`: selected-period entry count only

The account-specific response retains `rows` as period movements and adds
`openingBalanceMinor`, `periodDebitMinor`, `periodCreditMinor`, and
`closingBalanceMinor`. Each row's running balance begins at the opening balance.
Opening-only accounts/currencies remain visible even in an empty period. Natural
signs remain debit for assets/expenses and credit for liabilities/equity/revenue,
including existing custom account-code inference. No currency conversion or
cross-currency total is introduced.

Sources already return clinic calendar dates. The projection compares those ISO
date strings without parsing them into instants; manual/opening dates therefore
remain dates. Legacy unpadded pre-1000 source years are padded for comparison
without modifying source documents. Period rows sort by date, source, reference and source line index.
This is deterministic documentary ordering, not reconstructed intraday timing.

## Read-consumer inventory

- `app/finance/accounting/page.tsx`: trial shows opening, debit activity, credit
  activity and closing; ledger shows matching period summary and running balance;
  income is labeled by period; sheet and its earnings are labeled cumulative.
  Account/date/currency changes hide stale balances until their matching response
  arrives; failures no longer silently reuse another ledger's last response.
- `app/finance/page.tsx` → `components/finance/AccountingReportsTab.tsx`: passes
  cumulative balances separately. Assets/liabilities use cumulative balances;
  revenue/profit/debit/credit activity remains period-only. Opening-only currencies
  remain visible. The cumulative through-date is shown. Its independent read state
  withholds old figures during refresh and on rejected/non-OK/incomplete history
  responses; only a successful complete empty response means no entries. The
  existing GET reload supports recovery, and late older responses cannot replace
  newer accounting results. Existing effective report permissions hide retained
  figures immediately when access is removed and skip the accounting GET; loss of
  access is not presented as a successful empty ledger. Arithmetic balance is explicitly separate from cash
  reconciliation.
- `app/api/export/route.ts`, `kind=journal`: intentionally unchanged period journal
  rows via `journalEntries(from, to)`. It is an activity export, not a closing-balance
  export. No accounting-statement print endpoint or additional `/api/accounting`
  production read consumer was found by repository-wide search.
- Executive and FX readers in `lib/db.ts`: already read historical entries through
  their as-of date. They do not consume this API and remain unchanged.
- Pure `trialBalance`, `incomeStatement`, `balanceSheet` and
  `statementsByCurrency` callers/tests retain their existing input contract;
  `balanceSheet` documentation now makes cumulative input explicit. Finance report
  APIs/pages and financial permissions remain out of this slice.

## Cost and verification

The route uses one existing journal source read (the same historical range pattern
already used by executive reporting), rather than separately reading opening and
period sources. Runtime/memory scale linearly with source history for the report,
plus sorting account summaries and selected ledger rows. This is more data than a period-only read;
there is no new per-account database query, no persisted aggregate or cache, and no
performance claim about Production volume. A future optimization must preserve
source/reversal rules and return consistent opening/activity/closing projections.

Coverage includes synthetic API, pure projection, summary markup and real
PostgreSQL source date boundaries/earliest opening tests, plus built-browser
accountant checks for empty periods, currency changes, late responses and errors.
No Production financial data is required for these proofs.

## Local validation for this slice

- 96 focused unit/component/hook tests passed under Node 22, including the
  API carry-forward regression, FinancePage response-to-props integration and
  loading/error/409/rejection/malformed-response/recovery/late-response checks
- 2 focused real PostgreSQL 18.4 tests passed on a newly created guarded local
  cluster; the cluster was stopped afterward and its synthetic files retained
- Changed-file ESLint, focused TypeScript with Next ambient types, money
  aggregation scanning and whitespace checks passed
- Independent review approved after the blank-date matching, cumulative-prop
  plumbing and short-year source-date fixes
- Two real built-browser regressions are committed for mandatory CI execution.
  They were not executed locally; full build, complete suite, exact-commit CI,
  merge and Production verification remain release gates

The CI artifact `accounting-carry-forward-ui` explicitly allowlists only
`.settings-ui-artifacts/accounting-carry-forward.png` and
`.settings-ui-artifacts/accounting-carry-forward-mobile.png` with hidden-path
inclusion enabled. Both depict intercepted synthetic accountant fixtures.
