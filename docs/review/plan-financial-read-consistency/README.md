# Plan financial reads: FIN001, FIN002, FIN007

Stack base: PR #346, `9fe4f2276c43ee9821e6eb217fee8f93c238dcb2`.
This branch must follow #346. It does not merge, deploy, migrate a live database,
backfill links, change receipts, or repair FIN003/FIN011/FIN010/HR-GL.

## Observed failures on the stack base

The original synthetic reproductions were rerun before product edits: three
files, four failed assertions and one passing failure witness. An invoice-first
plan with principal1000 and receipt400 showed plan paid0/remaining1000 and no
invoice repayment schedule. A SAR100 plan displayed10000YER and was added to a
YER2500 plan as12500YER. The dossier labelled opening1000 as invoice total1000
when there were no invoices. Original audit evidence remains outside this branch;
`evidence/base-red.log` records the new-base run.

## Read contracts

- Approved agreement principal from #346 remains the first authority. Its reader
  accepts the caller's snapshot; the standalone public reader keeps its existing
  transaction wrapper. No approval or collection writer behavior changed.
- Plan queries, items, installment metadata, approved principal and invoice proof
  use one repeatable-read, read-only snapshot. PGlite retains the established
  shared-connection exception. These readers issue no financial writes.
- `invoiceFinancial` is an explicit read projection. It discovers only structural
  invoice/plan-item links, checks complete invoice ownership, patient and currency,
  and reads each correction-chain leaf through `readInvoiceSettlementPosition`.
  Recorded receipt values and append-only refunds/corrections remain authoritative.
- Receipts bearing both plan and invoice references are counted once through the
  invoice chain. Unassigned plan receipts, shared invoices, conflicting ownership
  or legacy treatment mixed with unapproved sources require financial review.
  No amount/name matching and no allocation of a patient's opening credit occurs.
- Classic installment invoices are recognized separately by their explicit
  invoice→plan and receipt→invoice+plan references with no treatment source links.
  They retain the original agreement principal and installment collection path;
  a partial installment invoice is never promoted to the full plan principal.
- Invoice repayment revisions keep arrangement/version/status/review metadata and
  revision-relative progress from `readDebtRepayments`. They are **not** inserted
  into `plan.installments`; those IDs still mean legacy plan installments. The
  original red schedule assertion therefore becomes an assertion on the separate
  `invoiceFinancial.schedules`, rather than manufacturing legacy installment IDs.
- A stale/review-required schedule does not produce an automated reminder.
  Missing/full-payment schedules do not invent installment dates. Unverified
  plan amounts are visibly excluded from finance KPI totals.
- Unauthorized clinical readers retain the allowlisted `withoutPlanPayments`
  projection, which excludes the new financial source and schedules. Finance-only
  readers receive no treatment items or revision-history notes.

## Display contracts

`/finance/plans` formats every amount/reminder in its plan's native currency and
shows separate currency KPI buckets. The patient plan card and plan print show
invoice-backed repayment schedules as existing-debt references. The old collection
form is not shown for these sources; collection remains in the existing account
workflow. Shared/unproven links show a review message rather than invented amounts.

The dossier labels invoice principal and opening balances separately. Net debt
uses the unchanged canonical ledger result. This is not a recalculation of debt.

## Regressions and runtime evidence

- PostgreSQL plan-position tests cover YER/SAR/USD, partial/full settlement,
  partial/full refunds, same-currency invoice correction and explicit receipt
  replacement, proven YER→SAR reclassification at recorded FX, revised schedules,
  dual plan/invoice references, cancelled invoice principal, shared ownership,
  draft versus approved principal, classic subsequent installments and read-only
  row-count checks. All fixtures are synthetic.
- Adjacent suites cover #346 principal, invoice settlement/reclassification,
  invoice revision, legacy treatment/void/onboarding/opening arrangements, inactive
  plans and existing installment collections.
- The production build is exercised through the repository security HTTP harness
  against a disposable PostgreSQL18 database, with actual authenticated requests.
  Browser checks use Chromium at390/1280 with Arabic locale. External requests are
  blocked. Read-only cases block browser writes; the follow-up reachability cases
  allow only clinical completion PATCH requests for their isolated synthetic plans,
  block every collection request, and compare receipt data before/after. These verify native currency values, invoice schedule
  print, opening labels, finance role boundaries, and the existing payment-privacy
  suite. The finance table retains its existing horizontal scroll on mobile;
  a separate check scrolls the amount into view and verifies its visible bounds.
- Component tests verify the formatter/KPI contract and reminder text without
  sending messages. The dossier renderer test retains a mocked read boundary;
  the browser test independently exercises the actual built dossier page.

No Firefox/WebKit or live-patient verification is claimed. No acceptance or release
is implied by local tests. CI and root review remain required, followed by merge
sequencing after #346.

## Local verification record

| Check | Result | Evidence |
| --- | --- | --- |
| Base reproduction | Four expected failures before changes | `evidence/base-red.log` |
| Full Vitest suite | 568 files; 10,079 passed, one existing skip | `evidence/unit-full-summary.log` |
| Final component/lifecycle checks | 35 passed, including review-required financial masking | `evidence/final-component.log` |
| PostgreSQL focused + core adjacent | 79 passed | `evidence/pg-final-targeted.log` |
| Final PostgreSQL plan position | 14 passed, includes three subsequently added cases | `evidence/pg-position-final.log` |
| PostgreSQL legacy/revision/collection regressions | 101 passed | `evidence/pg-adjacent.log` |
| Production build / typecheck | Passed | `evidence/build-final.log`, `evidence/typecheck-final.log` |
| ESLint | Zero errors; 208 warnings | `evidence/lint.log` |
| Built-server HTTP + Arabic Chromium390/1280 | 11 passed, including payment privacy | `evidence/http-ui-final.log` |
| Money aggregation guard | Passed | `evidence/money-scan.log` |

The full-suite count predates the final review-required display guard and its one
new lifecycle assertion; the affected component suite was rerun afterwards.
The PostgreSQL runs overlap; their counts must not be added as distinct tests.
All PostgreSQL checks used the isolated local PostgreSQL18.6 server.

Reproduction commands are recorded at the top of each log. Set
`TEST_DATABASE_URL` to a disposable PostgreSQL18 server for PG/HTTP checks. For
the HTTP run, build first and set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` where Chromium
is not managed by Playwright. No database credentials are included here.

Synthetic browser evidence:

- [Native currency totals and rows, desktop](evidence/plan-native-currencies-1280.png)
- [Mobile amount scrolled into view](evidence/plan-amount-visible-390.png)
- [Invoice repayment print](evidence/plan-invoice-schedule-1280.png)
- [Dossier opening separately labelled, mobile](evidence/dossier-opening-390.png)

## Independent review follow-up (three reproduced gaps)

Seven red assertions exposed draft debt inclusion, missing reachable print/finish
controls, and stale schedule rows. `evidence/review-gaps-red.log` records the run
before repair.

- The server now supplies `debtSource` only for available approved principal,
  structurally owned invoice debt, or the proven classic installment path with
  explicit plan/invoice/receipt links. A quote, installment proposal or consent
  flag alone is not debt proof. The finance screen fails closed when proof is
  missing: no debt KPI contribution or reminder. Unfunded1500 remains a quoted
  plan value in the patient card; the all-plans finance row says no proven debt.
- Print and clinical completion have their own controls, separate from legacy
  collection. The existing server role/status checks stay authoritative. Completed
  plans retain print but no finish action. Completion checks the current read
  generation, role, busy state, durable journal readiness/unresolved command and
  unsaved-draft guard. Server errors remain visible. No journal is acknowledged
  or removed by completion.
- Unallocated account credit reproduces a schedule whose raw reader returns both
  `requiresReview=true` and non-null rows. The plan projection withholds progress
  in that case; patient UI and print also independently reject stale rows. Valid
  invoice principal/settled amounts remain separate from unverified due dates.
- Actual Chromium clicks start in the patient Plans tab and open print links, then
  complete synthetic unpaid/partpaid/paid/review-required/drift plans. Already
  completed plans expose print only. Both widths390/1280 are exercised. Receipts,
  currencies and recorded exchange rates are compared unchanged.

The original local verification record above describes the first draft, not an
acceptance of the independent-review follow-up. Updated local checks are recorded below. Merge remains blocked pending root
review and integration/revalidation of the pending #346 correction.

| Follow-up check on base9fe4f227 | Result | Evidence |
| --- | --- | --- |
| Full Vitest | 569 files; 10,093 passed, one existing skip | `evidence/review-gaps-full-unit-summary.log` |
| Focused component/lifecycle/print | 47 passed | `evidence/review-gaps-components.log` |
| PostgreSQL plan sources and account-credit drift | 15 passed | `evidence/review-gaps-pg.log` |
| PostgreSQL adjacent regression suites | 169 passed | `evidence/review-gaps-pg-adjacent.log` |
| Actual HTTP + Arabic Chromium390/1280 | 13 passed | `evidence/review-gaps-http.log` |
| Production build / typecheck | Passed | `evidence/review-gaps-build.log`, `evidence/review-gaps-typecheck.log` |
| ESLint | Zero errors, 208 warnings; final changed-file scan zero errors | `evidence/review-gaps-lint.log`, `evidence/review-gaps-lint-changed.log` |

[Completed synthetic click flow at390](evidence/plan-controls-clicked-390.png) ·
[Completed synthetic click flow at1280](evidence/plan-controls-clicked-1280.png).

The first expanded HTTP attempt passed the prior11 checks but failed the new
click cases due to an overly exact accessible-name matcher and duplicate open
shift fixture. Those test setup errors were fixed; the final run above passed
all13 on the production build.

Pending dependency: root reported hosted operational journey failures on #346
and its author is diagnosing them. This follow-up does not edit unlinked funding
or signing functions. The composed stack must be revalidated after that correction;
these results do not claim CI success or release readiness.
