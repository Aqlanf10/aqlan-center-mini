# Performer commission reconciliation — bounded repair

Base: `e32efbaa15ef4996a8bc375a6ef01579683bab8a`.
Branch: `fix/performer-commission-reconciliation`.
Status: local candidate for dot review; no merge or deployment.

## Proven defect and repair

Two invoices for one patient, issued at exactly the same timestamp, belong to
performers A (30%) and B (40%). A partial YER collection of 4,000 must have a
stable FIFO allocation. Both commission readers sorted only by timestamp; an
unordered SQL result could move the entire collection from A to B.

The new unit regression failed before repair:

```
Expected Map { 11 => 4000, 12 => 0 }
Received Map { 11 => 0, 12 => 4000 }
```

The PostgreSQL regression read real synthetic rows, permuted only the unordered
invoice result rows in the supplied query runner, and failed with `expected 0 to
be 1200` for A's commission. This reproduces order dependence; it does not claim
a production incident or that a particular PostgreSQL plan always reverses rows.

The repair adds invoice ID ascending as the tie-break after the existing issue
timestamp in `allocateFifoByCurrency` and `commissionReport`. Dates and currency
buckets retain precedence. The `lib/db.ts` change is one comparator plus its
comment, notified to the parent before editing. No SQL, schema, expense writer,
permissions, currency configuration, debt correction, or print file changed.

## Policy and provenance inspected

`docs/DOCTOR_COMMISSION_ENGINE.md` and `lib/commission.ts` define ordinary rates
on collected cash and an explicit advanced `invoiced` basis. The calculation
uses `doctor_commission_history`, event-time policy resolution, then case/plan,
service, category and default rules. Missing policy produces no commission.
No new basis or rate policy is introduced.

`signClinicalVisit` copies each procedure's explicit doctor into its invoice
line, retaining the procedure source. The report reads that line doctor, and
resolves case/plan through the procedure/plan-item linkage. Existing attribution
freeze and event-time suites were included in verification.

The discount scenario deliberately **characterizes the existing documented
formula**, not a newly approved discount policy: gross share 10,000, invoice
net 8,000, 30% and collection 4,000 yield 1,500; refund 2,000 lowers this to 750.
Whether an invoice discount should instead reduce the doctor's commission base
is a separate business-policy decision; this patch does not change it.

## Synthetic acceptance evidence

| Scenario | Result |
| --- | --- |
| Equal-time invoices, both SQL row permutations | A earns 1,200; B earns 0, consistently |
| Two explicit performers, third doctor creates/signs invoice | Invoice source/performer identities match; creator earns nothing |
| Unsigned procedures then signed/done visit | No draft commission; partial payment yields A 1,500 and B 2,000 |
| Discount, linked refund, cancellation | Existing gross-share calculation preserved; cancelled USD invoice removed; YER unchanged |
| YER and USD payroll | Each currency's 1,200 commission matches its payable, expense party/currency and balanced journal settlement |
| Same payroll request replay and different-key excess request | Replay reuses disbursement; new duplicate rejected; no extra expense |
| Payroll reversal | Report paid returns to 0; due and payable/item remaining return to 1,200 |
| USD payment on YER invoice with stored base equivalent | Stored YER 500 yields commission 150 |
| USD payment on SAR invoice without SAR conversion evidence | FinancialCurrencyIntegrityError; invalid legacy fixture rolled back |
| Real HTTP summary and detail | Correct performer, currency, cash basis, source rule and matching totals |

## Checks

- Before repair: unit file 1 failed / 1 passed; PostgreSQL file 1 failed / 3 passed.
- After repair: 60 unit tests across five files passed.
- Targeted PostgreSQL 18.6 suite: 88 tests across six files passed. After adding
  the conversion-evidence case and stabilizing fixture dates, the final new file
  passed all five tests (89 unique PostgreSQL cases across these runs).
- Fresh `npm run build` passed. Two HTTP tests passed against its standalone
  server and isolated `aqlan_sec_http`, which the harness removed afterward.
- TypeScript check passed. Changed/new focused files lint clean; linting the
  large existing `lib/db.ts` reports eight pre-existing unused-symbol warnings,
  no errors. `git diff --check` passed.

Reproduction:

```sh
npm test -- __tests__/commission-fifo-order.test.ts __tests__/commission.test.ts __tests__/commission-event-time.test.ts __tests__/commission-detail.test.ts __tests__/commission-time.test.ts
TEST_DATABASE_URL='postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable' npm run test:postgres -- __tests__/postgres/performer-commission-reconciliation.test.ts __tests__/postgres/doctor-commission-engine.test.ts __tests__/postgres/commission-case-attribution-freeze.test.ts __tests__/postgres/commission-refund-aware.test.ts __tests__/postgres/p01-commission-currency.test.ts __tests__/postgres/payroll-journal-settlement.test.ts
# After a fresh local build:
TEST_DATABASE_URL='postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable' npm run test:security-http -- __tests__/security-http/performer-commission-http.test.ts
```

## Boundaries and review risk

- Historical derived balances for equal-time invoices can change to deterministic
  ID order. No stored financial history is rewritten; existing payouts are not
  reassigned or repaired. Review any impacted historical balances before release.
- Native currency isolation and the specific stored-base/unsupported-cross-FX
  cases are covered, not every conversion or later currency correction path.
- This does not establish complete HR, all installment performer-sharing rules,
  all treatment completion policies, or all commission payout races. No period
  closing race, Chromium, real patient data, Railway settings, Production,
  credentials, backup, merge or deployment was used.
- Independent dot review and any required CI remain before integration.
