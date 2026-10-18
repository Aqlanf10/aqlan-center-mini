# Review fixes and verification boundaries

Product heads reviewed: `9e4c55dcebe4d2dca9c6fdd50eb2a4f754612418` (collection/recovery/source guards) and `400858a9669c72d166c6529a6c22b5808d912f60` (patient lock ordering). This follow-up adds evidence only.

## Changes

- The plan UI persists the existing durable payment command with patient context, freezes inputs until resolved, and replays the exact saved body/key after a lost reply, reload and later refusal. Approved completed plans remain collectible.
- Direct approved invoice/opening receipt writers require an idempotency key and enforce source/account remainder. Successful replay precedes remainder checks. Approval rejects structurally linked prior clinical billing. Corrected invoice ancestors contribute once to current plan-reference progress.
- The common receipt transaction acquires patient KEY SHARE before shift/account locks. This removes the cycle between opening-table SHARE, payment FK acquisition and an addOnly opening writer holding patient UPDATE. An existing opening is refused early for addOnly; absence is still rechecked under the patient lock before insertion.

## Red/green evidence

All tests used synthetic disposable localhost PostgreSQL 18.6, never live patient data.

- On baseline `9258e2690f95c657f73f61bc14f9ee55844b5a05`, new principal regressions: [4 failed / 20 passed](evidence/review-postgres-red.log). The original built UI: [4 new cases failed / 4 existing passed](evidence/review-ui-red.log).
- After collection/recovery fixes: [15 HTTP/browser tests passed](evidence/review-ui-green.log), including active/completed plans at 390/1280px, real committed payment with lost response, reload, 409 refusal, reload and exact successful replay with one receipt. Two direct-source HTTP tests were added after the UI red run.
- On product head `9e4c55dc`, the deterministic opening/receipt test [failed with PostgreSQL 40P01 deadlock detected](evidence/review-opening-fence-red.log). It pauses the USD opening after patient UPDATE, starts direct collection against the approved SAR invoice, and releases the opening when the receipt reaches its patient fence (fixed) or INSERT (old). Actual PostgreSQL locks determine the outcome.
- On product head `400858a9`, [109 tests passed across five files](evidence/review-opening-fence-green.log): principal 25 plus opening mutation, payment concurrency, receipt correction and reversed installment recovery. The test checks both writes succeed, USD opening remains 7000 minor, SAR remainder is 20000 minor and exactly one receipt exists.
- Typecheck and production build passed on `400858a9`; focused lint passed with no errors and existing warnings; diff check passed. The full repository CI must run on the pushed evidence head. Earlier full-suite counts in verification.md describe the initial feature validation, not a fresh full run of these review fixes.

Commands (with the disposable TEST_DATABASE_URL and SESSION_SECRET configured):

```sh
npm run test:postgres -- __tests__/postgres/approved-agreement-principal.test.ts -t 'FK/table lock cycle'
npm run test:postgres -- __tests__/postgres/approved-agreement-principal.test.ts __tests__/postgres/opening-balance-mutation-concurrency.test.ts __tests__/postgres/payment-concurrency.test.ts __tests__/postgres/receipt-correction.test.ts __tests__/postgres/reversed-installment-recovery.test.ts
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:security-http -- __tests__/security-http/approved-agreement-principal-ui.test.ts __tests__/security-http/money-durable-recovery-ui.test.ts
npm run typecheck
npx --no-install eslint lib/db.ts __tests__/postgres/approved-agreement-principal.test.ts
env -u DATABASE_URL -u DATABASE_PUBLIC_URL -u PGHOST -u PGPASSWORD npm run build
```

## Limits

The deterministic new concurrency test covers direct approved SAR invoice collection versus adding an absent USD opening for the same patient. It is not exhaustive proof of every writer interleaving. Approval-versus-collection and fully-paid direct-source replay received source review, but this follow-up does not claim dedicated new tests for those two cases. Existing refund/correction suites passed; they do not establish support for every post-approval amendment.

Post-approval discount/cancellation credits and multi-source historical reconciliation remain unsupported and fail closed. Proposed plans and clinical consent alone do not create ledger debt. No real-patient cause has been established. No live data, production migration, merge or deployment was performed. Original untracked decision-review files remain untouched.

## CI lifecycle fixture repair after 09cab8ad

The two CI failures were reproduced locally: 2 failed / 27 passed in `patient-plans-visibility-lifecycle.test.tsx`. The Node hook fixture supplied neither IndexedDB/journal nor `window.dispatchEvent`. Production correctly failed closed with `ready=false`. The fixture also expected synchronous POST to the old plan endpoint and an ID-only response. The durable flow first reserves the command asynchronously, posts `/api/payments`, and requires a full actor/patient/target/key-bound receipt.

The repair changes only this fixture: an isolated actor/patient journal boundary, browser event dispatch, explicit microtask/render flushing, readiness assertions and a complete receipt for the original actor. The real durable hook, serializer, acknowledgment validator and identity fences remain in use. The later-principal test still requires exactly one POST, no extra read and no success publication, and now also explicitly rejects a leaked receipt link. Two added tests cover pending journal readiness and fail-closed storage failure, including direct invocation of disabled handlers. No production code, permission, financial calculation or identity protection changed.

Targeted unit run: 48 passed across lifecycle, durable-money-command and money-attempt. Real Chromium HTTP/recovery run: 34 passed across approved-agreement-principal-ui, money-durable-recovery-ui, money-attempt-real-react and financial-command-journal-browser. Typecheck and focused ESLint passed. The browser checks used the existing production build because this repair changes no application source.

Complete `npm test` after the fixture repair: **566 files passed; 10074 tests passed; 1 pre-existing repository skip** (10075 total, 302.14s). No test was skipped or weakened by this repair.
