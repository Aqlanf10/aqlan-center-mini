# Phase2 verification — local complete workflow

Product checkpoint: `ed425918`; HTTP fixture checkpoint: `128831ce` on `fix/invoice-currency-reclassification`,
based on merged main `482cbed4a434407514cdf73221e96cde7aaaadbb`. It reproduces
the preserved original branch's final tree, plus a payroll calculation fence
and successor receipt allocation fixes. This file supersedes phase1's scope statement, not its
evidence. Parent review, remote CI, merge and deployment remain pending.

## Synthetic workflow evidence

- `invoice-settlement-position.test.ts`:24 passing cases, including canonical
  writer2500YER→2500SAR with700/100/100SAR historical receipts and independent
 100YER credit. Settlement900SAR; remaining1600SAR; original receipt JSON
  unchanged. Ledger, debt, checkout, daily clinic, statement/debt reports and
  general ledger agree. Replay returns the acknowledgment without new cash.
- Partial/full refund and receipt correction append settlement effects once;
  duplicate refund key returns the same result. Races cover collection, refund,
  receipt correction and correction replay; no FK/shift deadlock remains.
- Rejected actor, closed period and paid commission preserve originals.
  Exclusive clinical plans retain item/case/visit IDs; shared coverage refuses.
- Historical cutoffs retain old YER invoice/receipt/commission facts. Native SAR
  receipt amounts and source per-receipt rounding remain the only authority.
- Both collected-cash and invoiced commissions preserve original policy time
  after30%→60% change. An unrelated SAR invoice receives no corrected receipt
  allocation. A new SAR receipt stays with that chain after a later same-currency
  invoice correction; its own original policy time is preserved. Full refund
  preserves each policy's existing behavior.
- `invoice-currency-schema.test.ts`: append-only/completeness/ownership/currency
  guards, byte-identical migration/runtime, and canonical SQL backup restored
  into a fresh migrated database with a subsequent refund, without disabled
  triggers or duplicated events.
- `debt-read-snapshot.test.ts` plus patient-ledger and feature composition:31
  passing PostgreSQL cases. Deterministic concurrent writer sees either whole
  old100 or whole new160 balance, never mixed60. Failed rollback destroys the
  backend. Actual PGlite adapter test keeps caller-owned transaction uncommitted.
- Commission consistency/detail/feature regression:72 passing cases before the
  additional invoiced-policy parameter; full suite below includes that case.

## Environment and commands

Only local disposable PostgreSQL18.6 instances on55432/55433 were used. Test
patient names/receipts are synthetic. No production query or migration, permission
change, patient edit, or stopped-staging start occurred. Tests use clinic zone
Asia/Aden, a synthetic session secret and local Chromium. Connection credentials
are deliberately omitted from this document.

```sh
npm test
npm run test:postgres
npm run typecheck
npm run lint
npm run scan:money
env -u DATABASE_URL -u TEST_DATABASE_URL -u RAILWAY_PROJECT_ID USE_LOCAL_DB=false npm run build
npm run test:security-http
git diff --check
```

| Check | Result |
| --- | --- |
| Full unit suite |565 files;10053 passed,1 previously skipped |
| Full PostgreSQL suite at final product |219 files;2329 passed,0 skipped |
| Final rollback/restore/feature regression |36 passed, including failure injected after partial write and failed rollback |
| Typecheck |Passed on final product ed425918 |
| Full lint |0 errors,208 warnings on final product; HTTP migration fixture also passes targeted lint |
| Money aggregation guard |Passed |
| Production build on continuation |Passed at ed425918 (final cleanup/payroll/successor fixes included) |
| Full built HTTP/UI (preserved pre-final-review tree) |227 files:215 passed,9 failed,3 skipped;1554 tests passed,3 failed,67 skipped; failures classified below |
| Final product financial + HR rollover HTTP/UI |7 files;25 passed; plus affected-suite rerun:7 passed files,1 baseline-PDF-failing file;50 passed tests,1 failed |
| Arabic390/1280 paper-bounds HTTP/UI |2 passed |
| Diff whitespace |Passed |

Earlier failed development runs exposed fixture schema omissions, rollback
cleanup, refund lock ordering and nested pool usage; those are not counted as
successful release checks. An obsolete pre-fix PostgreSQL run that timed out in
concurrent commissions was stopped; the fixed regression and final full run pass.

## Supported limits

YER→SAR only; fully proven lineage; no currency/identity/quantity combination;
no shared/partly covered plan or legacy installment agreement. Paid commission
expenses and any non-reversed commission-bearing payroll block correction. The
payroll guard is conservative across doctors. PostgreSQL receives snapshot
isolation; PGlite retains its shared-reader behavior without concurrent isolation.
Continuation publication is pending the parent’s explicit decision about the
baseline-reproduced PDF failures. No continuation push or Draft PR was made.
Runtime migration0063 requires normal parent-reviewed deployment and checksum
verification. The user's real patient record remains for the user to correct
through the reviewed UI after deployment.

## Local browser blocker (baseline reproduced)

The native A6 receipt signature glyph test fails with the same fragment coordinates
on this branch and on untouched main482c. Measured gap:1.832741999999996pt;
allowed maximum:0.5pt. Installed system Chromium is151.0.7922.173, while installed
Playwright1.63 expects Chromium153.0.8010.12 (revision1243). Downloading the matching
browser returned403 “Domain forbidden”; no bypass was attempted. Receipt print
CSS, route and glyph oracle are unchanged. This is a failed check, not a pass.

[Machine-readable baseline comparison](evidence/phase2/pdf-baseline-comparison.json)
and the filtered [baseline HTTP log](evidence/phase2/baseline-pdf-http.log) record
the reproduction. Other selected local logs and six synthetic Arabic screenshots
at390/1280 are in [phase2 evidence](evidence/phase2/). No actual patient data is used.

## Final review regressions at ed425918

A new payroll calculation inserts its run before reading commission and inserting
items. Correction now takes SHARE locks on expenses, payroll runs and payroll
items before patient/receipt/shift locks. The regression observes an actual
PostgreSQL waiting ShareLock: no correction exists until the calculation transaction
ends. Removing the new run fence makes that test fail.

A new SAR receipt followed by another same-currency invoice correction must retain
its target chain for commission allocation. Both commission bases previously
allocated3000minor to an unrelated doctor's invoice; the regression now proves0.
A batch invoice query resolves owned, same-currency successors and reserves those
receipts for the proven reclassified leaf. It adds no per-receipt query or cash
write. The original900SAR receipts retain30% policy; the later100SAR receipt retains
its60% policy. Refunding the original900SAR leaves only that later receipt's effect.
The feature and commission-detail regression passes39 cases. The final unit
suite passes10053 tests (565 files;1 prior skip); final PostgreSQL passes2329
tests (219 files;0 skipped).
Final production build, typecheck, full lint (0 errors,208 warnings) and money
scan pass. Earlier full results remain explicitly checkpointed.

## Full HTTP failure classification and recovery

The initial broad run completed215 passing files and9 failing files (3 explicitly
skipped files). Seven failures happened in setup: three lab suites require CI
flags, three inventory suites require INVENTORY_CHROMIUM_EXECUTABLE on this local
machine, and an HR fixture expected an exact migration list without0063. The HR
fixture now includes0063, retaining its exact registration and partial-schema
refusal assertions. Its file is not in PR342's diff.

Two HR rollover assertions received401 because the separate focused HTTP server
occupied the HR helper's derived port3218. That local scheduling error was fixed
by using3227/3228. Both rollover tests pass in the final7-file/25-test run. The
initial broad run is not relabeled green; the affected suites are rerun separately.

The lab dispatch PDF test also fails on untouched main482c with “PDF service label
must occur in exactly one field block”; its diagnostic uploader additionally
requires real GitHub run metadata unavailable in this local run. No fake run ID
or altered PDF oracle was supplied. Receipt and lab PDF baseline failures remain
open local verification blockers pending a matching browser/remote CI decision.
