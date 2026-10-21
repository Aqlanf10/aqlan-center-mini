# Performer commission reconciliation — bounded repair

Base: `e32efbaa15ef4996a8bc375a6ef01579683bab8a`.
Branch: `fix/performer-commission-reconciliation`.
Status: Draft PR #374 for dot review; no merge or deployment.
Initial candidate: `ada1b065b26b7ba676db357753420e84e81856c8`; the follow-up below supersedes its current-ID-only ordering.

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

The initial candidate added the current invoice ID as a tie-break. Parent review
correctly identified that this moves a corrected invoice behind another equal-time
invoice. A new real-writer witness reproduced that defect on Node 22: after each
of **two successive same-value corrections**, A's coverage/commission changed
from 4,000/1,200 to 0/0, while B changed from 0/0 to 4,000/1,600. Both invoice-linked
and account collection cases failed. The original receipt rows, invoice amount,
performer/work amount and timestamp were verified unchanged.

The follow-up projects `allocation_origin_id` from the persisted
`invoice_corrections` graph and passes it as `CommissionInvoice.allocationOriginId`.
The root is the node with no predecessor **in the traversed same-patient,
same-currency segment**, not the smallest numerical ID, an inferred description,
or the immediately preceding replacement. A currency transition stops traversal.
An unresolved root refuses the report instead of silently assigning a new order.

Both comparators now order by the existing timestamp, then the proven origin ID
(or the invoice's own ID for the pure helper's ordinary invoices), then current
ID only as a final deterministic tie-break. The production reader always supplies
the validated origin. The timestamp remains the existing allocation timestamp;
policy time is unchanged. This preserves the original FIFO position through
same-currency correction chains without selecting priority from replacement IDs.

The runtime changes are confined to these ordering fields/comparators in
`lib/db.ts` and `lib/commission.ts`, specifically authorized by the parent after
the witness request. No expense writer, supplier path, 0065 tool, schema,
permissions, currency eligibility/configuration, debt correction writer or print
file is changed.

### Explicit reservations and currency boundaries

The existing `allocatedInvoiceId` path still reserves its exact target before
legacy FIFO. An additional PostgreSQL case uses complete trigger-validated
historical reclassification evidence: a reserved SAR 4,000 stays with B (earning
1,600), while an ordinary SAR 2,000 receipt goes to the earlier SAR invoice for A
(earning 600). The result remains unchanged after a same-value replacement of B's
invoice, and the evidence resolves to its new leaf. Receipt rows remain identical.
The old YER source has a lower ID than both SAR invoices; it must not give the
later SAR reissue priority over the earlier SAR invoice. This case proves both
the currency boundary and preservation of the explicit reservation.

Ordinary `payments.invoice_id` alone still does not create an explicit reservation
in this reader: it establishes settlement currency, while its collection uses the
existing pooled FIFO unless proven reclassification evidence resolves a target.
That broader policy is unchanged, and the new witness covers both ordinary linked
receipts and account collection. No claim of redesigning direct receipt allocation
is made.

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
| Same-value correction, then correction of replacement; linked and account receipts | Coverage 4,000/0 and commission 1,200/0 unchanged after each correction; immutable cash snapshot identical |
| Explicit reservation and currency-segment root | Reserved 4,000 remains B; ordinary 2,000 remains A before/after replacement; YER root priority does not cross into SAR |
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

Actual follow-up runtime: **Node v22.23.3**, PostgreSQL **18.6**. Node 22 comes
from `/workspace/.cloud-tools/node_modules/node/bin/node`; prepending that bin
directory to PATH also runs child workers and the standalone server on Node 22.
The initial candidate's Node 24 evidence is historical only and does not substitute
for this follow-up verification.

- Initial defect: unit 1 failed / 1 passed; PostgreSQL 1 failed / 3 passed.
- Follow-up before repair on `ada1b065`: new unit 1 failed / 2 passed; two
  correction witnesses failed (four before/after equality assertions), with the
  other five cases excluded by the targeted test-name filter.
- Follow-up on Node 22: **69/69 unit tests in seven files**, including two
  existing PGlite-backed commission readers; **92/92 PostgreSQL tests in six
  files**; **2/2 real HTTP tests** against the fresh Node 22 standalone build.
- `next build` and standalone `tsc --noEmit` both passed on Node 22 with
  `--max-old-space-size=4096`. Scoped ESLint: 0 errors, eight existing unused-symbol
  warnings in `lib/db.ts`; no new warnings. `git diff --check` passed.
- The new PostgreSQL file independently passed all eight cases after the repair,
  including correction chains, explicit reservation, payroll and conversion proof.
  No skipped witness is counted as a passing test. The final 92-test run includes
  the complete new file with no test-name filter.
- HTTP used only the isolated synthetic `aqlan_sec_http`; the harness stopped the
  server and removed the database after the two tests. No Chromium was launched.

Reproduction:

```sh
# Use Node 22 on PATH for every command and child process.
# Local runtime: /workspace/.cloud-tools/node_modules/node/bin/node (v22.23.3).
node --version
npm test -- __tests__/commission-fifo-order.test.ts __tests__/commission.test.ts __tests__/commission-event-time.test.ts __tests__/commission-detail.test.ts __tests__/commission-time.test.ts __tests__/commission-refund-aware.test.ts __tests__/commission-material-rate-event-time.test.ts
TEST_DATABASE_URL='postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable' npm run test:postgres -- __tests__/postgres/performer-commission-reconciliation.test.ts __tests__/postgres/doctor-commission-engine.test.ts __tests__/postgres/commission-case-attribution-freeze.test.ts __tests__/postgres/commission-refund-aware.test.ts __tests__/postgres/p01-commission-currency.test.ts __tests__/postgres/payroll-journal-settlement.test.ts
# After a fresh local build:
TEST_DATABASE_URL='postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable' npm run test:security-http -- __tests__/security-http/performer-commission-http.test.ts
```

## Boundaries and review risk

- The correction-priority blocker from the initial candidate is reproduced and
  addressed by the persisted same-currency root, with the above before/after
  witnesses. A legacy replacement without recorded lineage cannot inherit an
  origin by guesswork. No historical backfill is performed.
- Historical derived balances for equal-time invoices can change to deterministic
  source-identity order. No stored financial history is rewritten; existing payouts are not
  reassigned or repaired. Review any impacted historical balances before release.
- Native currency isolation and the specific stored-base/unsupported-cross-FX
  cases are covered, not every conversion or later currency correction path.
- This does not establish complete HR, all installment performer-sharing rules,
  all treatment completion policies, or all commission payout races. No period
  closing race, Chromium, real patient data, Railway settings, Production,
  credentials, backup, merge or deployment was used.
- Independent dot review and any required CI remain before integration.
