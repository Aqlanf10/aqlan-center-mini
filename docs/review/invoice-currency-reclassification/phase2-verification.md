# Phase2 verification — local complete workflow

Main workflow checkpoint: `f804f6c8`. Final cleanup checkpoint: `53c41e61`
(discard connections on failed rollback/advisory unlock; no happy-path change).
Remote Draft PR343 remains `5910878f`; parent has not authorized another push.
This file supersedes phase1's scope statement, not its evidence. Parent review,
remote CI, merge and deployment remain pending.

## Synthetic workflow evidence

- `invoice-settlement-position.test.ts`:23 passing cases, including canonical
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
  allocation. Full refund preserves each policy's existing behavior.
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
| Full PostgreSQL suite |219 files;2327 passed,0 skipped |
| Final rollback/restore/feature regression |36 passed, including failure injected after partial write and failed rollback |
| Typecheck |Passed, including53c41e61 |
| Full lint |0 errors,208 warnings; final cleanup files also pass targeted lint |
| Money aggregation guard |Passed |
| Production build atf804f6c8 |Passed |
| Full built HTTP/UI |Running; result and screenshot references pending |
| Final cleanup build + focused HTTP/UI |Pending full HTTP completion to avoid rebuilding beneath its live server |
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
Runtime migration0063 requires normal parent-reviewed deployment and checksum
verification. The user's real patient record remains for the user to correct
through the reviewed UI after deployment.
