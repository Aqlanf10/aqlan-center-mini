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

## PostgreSQL integration contract repair after a59edb31

Reproduced the six failing files: 12 failed / 28 passed, with 7 periodontal restore cases unable to start because their chain guard did not recognize0064. The fix updates test contracts only, plus the source-generated disclosure allowlist. It does not change production schema, migrations, reports, financial calculations, HR behaviour or restore logic.

- Runtime registry remains an exact equality assertion, including0064 name/checksum/adopted=false. Its numbered SQL is checked byte-for-byte against runtime SQL and against reviewed SHA-256 `aefc040a29c8b887a8eeca073103ce4268a8851b89e0025b406941e48f247655`. Debt storage now expects the actual last registered version0064.
- The periodontal fixture recognizes only the exact58-entry chain ending `0064_approved_agreement_principal.sql`, recursively validates the existing57-entry chain and retains test-only sentinel9000. Unknown suffix/count/gap refusal remains; the added unit test checks modified suffixes, internal omissions and an unknown future version. No periodontal feature is activated.
- Both report fixtures retain `search_path=pg_temp` and mocked schema bootstrap. The empty approved-source relation includes all six queried columns and participates in fixture truncation/nonmutation snapshots. No public-table fallback or swallowed read error was added.

Disclosure policy was generated using the unchanged guarded `scripts/generate-preflight-disclosure.ts` on pristine template0 PostgreSQL18.6 numbered-migration/runtime databases. Every new hash was independently mapped back to the corresponding detailed source catalogs using the generator's pg_catalog search path. All87 additions belong to approved-agreement objects; no old hash was removed:

| Section | Added identities | Added text hashes |
| --- | ---: | --- |
| columns | 15 | 0 |
| constraints | 31 | columns4, definition10 |
| internal FK triggers | 12 | constraint3, definition12 |

Policy SHA-256 changed from `ab54ef23198db0cc58f0465c5841c2920a935c238ca1b3c0ef4252475d6969a3` to `455b718f2e959199f4a5ad18bdb32fd14c749ba225d994737b2e3eb2d1b06084`. The frozen baseline manifest, current schema contract, discrepancy classifications, template1 canary and unknown-name WITHHELD assertions were not edited. Ownership verification returned0 unexpected differences and the existing16 open convergence findings; global application-schema equality remains false.

Targeted rerun: all47 PostgreSQL cases passed, including real restore and all10 fingerprint cases. Candidate-chain unit tests:8 passed. Full PostgreSQL verification uses a clean tracked checkout, matching CI; the original untracked decision-review files remain untouched in the authoring workspace.

Final verification of test/schema fix `4b4cf3cf37966c20dbee64df2397dbd70d32187f`:

- Complete unit suite:566 files passed,10075 tests passed,1 pre-existing skip. Typecheck, focused ESLint and diff check passed.
- Full PostgreSQL invocation on the clean checkout ran all221 tracked files:220 passed /2365 tests passed. The preflight-artifact suite could not initialize its3 cases because this verification checkout symlinked node_modules to the authoring checkout; the unchanged esbuild allowlist correctly rejected dependency paths outside its own root. This was a harness failure, not a green full invocation.
- Re-running the unchanged preflight-artifact file from the authoring checkout with local dependency paths passed all3 cases in1.88s. No guard was relaxed and no source fix was needed. Combined coverage is2368 passing PostgreSQL cases; fresh CI must confirm a single complete green run with its normal local npm installation.

[Full PostgreSQL log](evidence/integration-full-postgres.log) · [Preflight artifact rerun](evidence/integration-preflight-rerun.log) · [Full unit log](evidence/integration-full-unit.log)

```sh
# Disposable local PostgreSQL18 only, with TEST_DATABASE_URL and SESSION_SECRET set.
CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE=1 MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1 npm run test:postgres
npm run test:postgres -- __tests__/postgres/preflight-artifact.test.ts
npm test
npm run typecheck
npm run schema:ownership:verify -- --output /tmp/pr346-schema-ownership.json
npx --no-install tsx scripts/generate-preflight-disclosure.ts > /tmp/pr346-disclosure-candidate.json
```

## HTTP installment interception repair after e0ec4ed0

PR CI run39167241497 passed PostgreSQL/schema/build, then failed four browser cases in `plan-installment-idempotency-ui.test.ts`. Authenticated check-run annotations identified the exact failures at lines87,124,147; local execution on the unchanged head reproduced4/4 failures in130.78s before any retry or edit.

The test intercepted the retired UI transport `/api/plans/:id`, so it never corrupted or dropped the actual `/api/payments` reply. The real collection succeeded normally, leaving no recovery button to find. It also waited for the old installment success text rather than the current payment success text. This was a stale test interception/expectation, not a production recovery failure.

Only that browser test changed: intercept and observe `/api/payments`, expect the current success message, and additionally assert the exact replay body is unchanged and targets the expected patient/plan. Existing malformed-response refusal, real server commit before dropped response, replay HTTP200, stable key, one-receipt count and double-click safety assertions remain. No timeout, skip, production code or identity/financial guard changed.

The four cases passed after repair in10.70s against a freshly rebuilt application. Build, typecheck, focused ESLint and diff check passed. Full unfiltered `npm run test:security-http` runs against the isolated synthetic PostgreSQL harness with Chromium and PDF tooling; its final result is recorded below.

Local full-suite environment note: the first unfiltered run used system Chromium151.0.7922.173, while the project's pinned Playwright browser is Chromium153.0.8010.12 (revision1243). It also did not set the GitHub Actions-only CI environment markers. The lab-dispatch privacy and patient lab-status refusal suites explicitly assert those markers in their setup. The receipt provenance PDF emitted a diagnostic artifact with signature fragment gap1.832742pt, exceeding the existing exact0.5pt oracle; this browser/environment difference is a hypothesis, not a proven production regression or a reason to relax the assertion. Installing the pinned browser in `/tmp/pr346-playwright` was attempted both normally and with additional execution permission; the official download returned HTTP403 `Domain forbidden`. No PDF oracle or CI-only guard was changed.

The original full unfiltered HTTP run (session17165) terminated with exit1 after1868.33s: **218 files passed / 7 failed / 3 skipped; 1573 tests passed / 1 failed / 60 skipped**. The six setup failures were the three CI-marker-gated lab suites (`lab-dispatch-privacy-ui`, `patient-lab-status-refusal-ui`, `patient-lab-read-state-ui`) and three inventory suites (`inventory-disabled-http-ui`, `inventory-foundation-http-ui`, `inventory-overview-visual`) missing Playwright's pinned headless-shell executable. The single executed test failure was `receipt-provenance-ui` at its unchanged exact signature geometry assertion. The harness stopped its server and dropped its isolated database normally. This is **not** a fully green local suite.

Receipt baseline comparison: latest successful main CI39086383742 used `a03aea1eb911c3c886028bc902f6f4f97f3546cf`. `git diff` against that SHA is empty for the receipt provenance UI test, PDF glyph helper, receipt evidence helper, `components/ReceiptProvenance.tsx`, both `lib/receipt-provenance*.ts` files, and `app/print/receipt/[id]/page.tsx`. This establishes those files are unchanged, not the cause of the local PDF failure. Hosted CI with its pinned browser remains decisive.

The requested rerun of the21 lab cases used `CI=true`, `GITHUB_ACTIONS=true`, `CLINIC_TIME_ZONE=Asia/Aden`, the workflow's literal synthetic `SESSION_SECRET`, and localhost-only disposable database URLs adapted to the existing test container's port55445/user. System Chromium151 remained the available browser. Result: **20 passed / 1 failed**,2 files passed/1 failed, exit1 in36.56s. Both patient-lab read-state/status-refusal suites passed. The lab-dispatch privacy case reached native PDF inspection and failed `PDF service label must occur in exactly one field block`; its failure-diagnostic emitter additionally rejected absent real `GITHUB_RUN_ID` (no hosted-run identity was invented). No cases were skipped in this rerun, and neither PDF assertion was changed.

Raw evidence and exact test patch are preserved locally in `/workspace/reviews/pr346-http/`: `full.log`, `full-terminal.txt`, `lab-rerun.log`, `fix.diff`, and the earlier red/green/build/typecheck/lint logs. The original full run's60 skips are reported as emitted; the21 lab cases were subsequently executed as above, not counted as successful in the original run. No claim of a completely green local HTTP suite is made. Parent explicitly authorized pushing this test/docs-only repair after these terminal results so the full hosted CI with its pinned browser can decide; merge/release remain blocked pending hosted CI and independent review.
