# Collection idempotency HTTP boundary — local review candidate

Base: `9e8fd301ebcdee1197b75bc6d182861ff35712b8` (remote main checked read-only).
Branch: `fix/require-collection-idempotency`. No push, PR, merge or deployment.
Only synthetic fixtures; no live patient investigation or receipt mutation.

## Reproduction before the fix

Commit `4a9978c51b5d6e43d131349fb8aa7bc59e6f8a6d` contains the baseline reproduction test on unchanged application code. Build succeeded. Real HTTP against isolated PostgreSQL 18.6 passed its one test: two identical unkeyed requests returned 201/201, distinct receipt IDs/numbers, and two rows of 205000 YER with NULL idempotency keys. This establishes an admission gap, not the cause of the reported image or proof of duplicate physical cash.

## Change

`POST /api/payments` and `POST /api/plans/[id]` now reject missing/blank keys with HTTP 400 and `idempotency_key_required`; malformed keys remain rejected. Checks precede financial reads/writers. Recovery requests retain their existing dedicated parser and missing-key rejection. No database/internal writer/importer changes, amount/date deduplication, or UI retry changes.

The final HTTP regression replaces the baseline assertion with rejection and unchanged hashes of payments, invoices, invoice items, installments, plans, audit and opening balances. Unit spies independently prove no financial adapter calls on missing/invalid keys. HTTP/PG cases cover account, invoice, installment plan through the general door, and direct plan: concurrent same-key requests return one 201 and two 200s, subsequent exact retry returns the same receipt, changed amount with the same key returns 409, and distinct legitimate keys create two receipts totaling 410000 YER. Plan cases produce exactly two new installment invoices for those two distinct keys.

## Caller audit and coordinated fixture delta

- `CollectPaymentModal` serves ledger, summary, today's visit and arrival collection. `PatientPlans` also posts through the durable money hook. Both already persist the key and body before sending. `PatientPlans`' other direct `/api/plans/[id]` fetch is PATCH, not collection.
- No script callers of these two HTTP collection endpoints were found. Internal writers and importers are intentionally unchanged.
- Explicit recovery, approved agreement collection and debt installment collection already reject absent keys before their financial transactions.
- Updated legitimate HTTP test fixtures in `installment-plan-collect-http`, `opening-balance-currency-http`, `reversed-installment-recovery-http`, and `td05-currency-safety`. Keys are explicit per intended operation; the common HTTP helper does not silently inject or rotate them. Authorization and intentional missing-key tests remain unchanged.
- The parent subsequently authorized the two deferred fixture edits. `__tests__/security-http/historical-correction-recovery-ui.test.ts:21` now supplies `Idempotency-Key: history-ui-payment-${patientId}` for the synthetic opening collection; `__tests__/security-http/legacy-balance-arrangement-http.test.ts:105` supplies `Idempotency-Key: legacy-arrangement-payment-${patientId}` as the fifth `authedMutation` argument. These are the only changes in those two files: no assertion, payload, test path, skip, or retry behavior changed. When integrating concurrent correction/legacy branches, retain their substantive changes and carry over only these explicit header arguments. The previous fixture coordination blocker is resolved.

## Verification commands and limits

Use the already installed image only:

```sh
docker run --pull=never --name collection-idempotency-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55439:5432 -d postgres:18-alpine
docker exec collection-idempotency-pg createdb -U postgres aqlan_p1_test
export TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/aqlan_p1_test
npm run build
npm run test:postgres -- __tests__/postgres/payment-concurrency.test.ts
npm test -- __tests__/collection-idempotency-boundary.test.ts __tests__/reversed-installment-recovery-routes.test.ts __tests__/durable-money-command.test.ts __tests__/money-attempt.test.ts __tests__/invoice-command-transport.test.ts __tests__/use-durable-money-attempt-headless.test.ts
npm run test:security-http -- __tests__/security-http/collection-idempotency-required-http.test.ts __tests__/security-http/installment-plan-collect-http.test.ts __tests__/security-http/opening-balance-currency-http.test.ts __tests__/security-http/reversed-installment-recovery-http.test.ts __tests__/security-http/inactive-plan-collections-http.test.ts __tests__/security-http/roles-cashier-accountant-http.test.ts __tests__/security-http/rbac.test.ts
npm run typecheck
```

The initial PG invocation against database `postgres` was rejected by the repository target guard; creating the required isolated `aqlan_p1_test` database resolved it without bypassing the guard. PostgreSQL concurrency suite: 14/14 passed. Unit suites: 101/101 passed. Build passed after correcting a test header type. An early new HTTP test incorrectly assumed direct-plan responses contain a full receipt; it was corrected to follow that route's `paymentId` into PostgreSQL and assert actual receipt identity. An expanded HTTP run then passed the collection cases but had one portal statement 500 at `rbac.test.ts:127`; the preceding run had passed that RBAC case. No logs or production data were inspected to speculate on its cause. The final complete repeat passed **52/52 tests across all seven HTTP files**, with no excluded case. The transient portal failure remains a recorded limit, not a diagnosed or fixed issue.

No local Chromium was launched. The new hook test executes production `useDurableMoneyAttempt` with controlled React lifecycle and journal adapters: synchronous double-click lock, persistence before POST, lost response, fresh module/reload, refusal to mutate an unresolved body, and identical retry key/body. This is **not** a browser or real IndexedDB/CAS revalidation. Existing browser suites remain unchanged and require an authorized environment for execution; the TD05 fixture edits were typechecked, not browser-run. Full test suite was not claimed.

No period-close investigation, live correction/refund, or patient-identifying artifact was performed.

Final `npm run typecheck`: exit 0. ESLint on changed code/tests: zero errors, one existing unused `Currency` warning in the plan route; the three new tests lint clean. `git diff --check`: clean. Build retains the existing dynamic-filesystem tracing warning in `lib/migration-files.ts`. The synthetic PostgreSQL container was removed after testing; no image was pulled.

## Authorized follow-up validation

The follow-up changed only the two fixture header arguments above (plus review documentation). `npm run typecheck` passed. The prior seven-file HTTP command was repeated with `__tests__/security-http/legacy-balance-arrangement-http.test.ts` added: **55/55 passed across eight files**. The historical browser fixture was not executed because its unconditional setup launches Chromium; no assertions were weakened to make it runnable. The application build from the prior candidate remains applicable: no application source changed in this follow-up.

Additional foreign-exchange/retry verification on the same isolated PostgreSQL 18.6 instance:

```sh
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/aqlan_p1_test npm run test:postgres -- __tests__/postgres/payment-settings-fx-replay.test.ts __tests__/postgres/payment-settings-fx-replay-races.test.ts
```

Result: **48/48 passed across two files**. ESLint on the two newly coordinated fixture files passed with zero errors/warnings. `git diff --check` passed. The synthetic container was removed again after testing; no download or production connection occurred.

Independent read-only review by a non-implementer is recorded in [independent-review.md](independent-review.md). The reviewer found no blocking correctness issue and independently passed 83 unit tests across four files; these overlap the implementer suites and are not an additional distinct-test count. Reviewer also traced finance and patient-page collection wrappers, reception/appointments entrypoints, and confirmed registration does not create receipts.
