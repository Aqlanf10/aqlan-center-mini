# Synthetic invoice/debt acceptance — awaits dot review

Base: `e32efbaa15ef4996a8bc375a6ef01579683bab8a`, verified after fetching
`fix/ortho-canonical-financial-read` from `https://github.com/Aqlanf10/aqlan-center-mini.git`.
Independent branch: `test/finance-http-pg-acceptance`.

No application defect was reproduced by these journeys. This is a coverage-only
change, with no production code, migration, owner permissions, or currency changes.
No checkout test was changed. No browser or period-closing race was run.

## PostgreSQL 18 acceptance and guard follow-up — 2026-10-21 UTC

The unchanged nine HTTP journeys passed on actual **PostgreSQL 18.6 (Debian
18.6-1.pgdg13+2), server_version_num=180006**, using **Node 22.23.3**.
See `pg18-run.log`: 9/9 passed in 6.20 seconds. This supersedes PostgreSQL 16
as the database-version acceptance evidence; it does not claim browser or full CI acceptance.
The application build was unchanged from the earlier successful Node 22 default
Turbopack build; only the runner, guard tests, declarations and evidence changed.

The runner now reuses `validateOperationalVerificationEnvironment` and
`validateLocalVerificationTarget` from the project policy, and
`assertPostgresMajorOrThrow` / `postgresMajorFromVersionNum` from `lib/env-contract.ts`.
Those shared project files and the supported-major value were not modified.
Both explicit test classifications are mandatory before client construction;
production, PG overrides and conflicting original aliases are rejected before
any overwrite. Actual server major is verified before launching global setup.

Before creating the PostgreSQL 18 container, the 40-case runner suite passed,
including 39 refusal cases (28 original-environment cases plus 3 additional PG
settings, 5 wrong/invalid versions and 3 target-state cases). Mocks prove no
connection for unsafe environments and no setup launch for failed server checks;
no database is created by these guard tests. Combined verification with the
existing PostgreSQL-target suite passed 86/86 (`guard-related.log`). Full Node 22
TypeScript, scoped ESLint, runner syntax and diff checks passed.

Isolated target identity, checked before the HTTP harness initialized its database:
- Container: `aqlan-finance-acceptance-pg18-synthetic`.
- Container ID: `537ce8c5a8aba686c8a2e698bb69def56fd142d985a6ab982b368186066ccf98`.
- Label: `aqlan.purpose=finance-http-pg18-synthetic`.
- Image: `postgres:18`, digest `sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336`.
- Bound only to `127.0.0.1:55439`; fresh admin DB `aqlan_finance_test`.
- `aqlan_sec_http` absent before setup, created by the harness and dropped after testing.
- Synthetic users/sessions only; no production target or data. Container identity
  and harness absence are checked again before removing the task's container/volume.

## Earlier PostgreSQL 16 evidence (not PostgreSQL 18 acceptance)

2026-10-21 UTC, earlier verification on Node 22.23.3 (the repository engine), PostgreSQL 16.15 (official postgres:16 container),
Next 16.3.8 built using the default Turbopack build. PostgreSQL was created for
this task only, bound to 127.0.0.1:55439. The harness creates and drops its own
`aqlan_sec_http`; all actors, sessions, patients, invoices and receipts are synthetic.
The server listens only on 127.0.0.1:3249.

- First run on the environment default Node 24.19.0: 6/6 HTTP/PG tests passed (`first-run.log`).
- Expanded run on Node 24.19.0: 9/9 passed. Final build/runtime verification was repeated on Node 22.23.3: 9/9 HTTP/PG tests passed (`final-run.log`).
- `npm run build`: passed with local copied dependencies.
- `npm run typecheck`: passed.
- ESLint on the new test and `node --check` on the runner: passed.
- `git diff --check`: passed.
- Runner negative checks: missing URL, remote host and wrong database name all refused before Vitest or database setup.

The original dependency symlink was incompatible with Turbopack's project-root
resolution. An attempted webpack build also failed on the existing
`app/portal/page.tsx -> lib/portal.ts -> node:crypto` client import. Neither was
patched: copying installed dependencies into the isolated worktree allowed the
repository's default build to pass. These are build-path observations, not a
claimed financial defect or a before/after financial repair.

## Actual journeys

For each YER/SAR/USD, create an invoice over HTTP, discard the first response body,
replay the command and verify one PostgreSQL invoice. Create and replay a debt
schedule (400 minor units past due, 600 future) without a second principal or cash.
Collect 200, discard acknowledgement and replay to the exact receipt; changed
intent with the same key is rejected. The account remains 800 while the canonical
HTTP due recommendation is 200; the future 600 is not currently due.

Correct the receipt from 200 to 150 through HTTP, replay to the same reversal and
replacement, compare the original PostgreSQL row (including timestamps) unchanged,
and observe account debt 850. The schedule requires review and further collection
is refused. Explicit ordinary payment of 1000 yields credit 150. Cancel the invoice:
credit becomes 1150, all existing receipt rows remain byte-for-byte JSON equivalent.
Refund that last receipt, replay the refund once, and verify credit 150 in both
account JSON and server-rendered printable statement, including receipt identities.
Exactly one invoice exists throughout each lifecycle.

Additional three cases settle the currently due 400 and verify due-now zero with
600 future principal intact. Cancelling/replaying only the schedule leaves the
invoice debt, original receipt and timestamps unchanged.

One patient holds invoices in all three currencies simultaneously. A SAR payment
changes only SAR; cross-patient schedule, collection and payment links are refused
with no receipts. Foreign-to-foreign collection and overcollection through the
bounded installment endpoint are refused.

Two FX cases use the existing synthetic fixture values 140 YER per SAR and 530 YER per USD
from `debt-installment-collection.test.ts`, explicitly stored in test settings.
They are not market rates. One SAR/USD major unit pays the recorded YER amount.
Removing the setting still permits exact replay and refund using saved evidence,
while a fresh foreign payment is rejected. No replacement exchange rate is invented.

## Reproduce

First run `node node_modules/vitest/vitest.mjs run __tests__/finance-lifecycle-runner.test.ts` on Node 22, before creating any database.
Use a fresh disposable local PostgreSQL 18 instance. Never point this at an existing
application server or production database. Install dependencies locally (`npm ci`)
and build the exact candidate (`npm run build`) first. Example synthetic setup:

```sh
docker run --name aqlan-finance-acceptance-pg18-synthetic \
  -e POSTGRES_PASSWORD=synthetic-acceptance-only \
  -e POSTGRES_DB=aqlan_finance_test \
  -p 127.0.0.1:55439:5432 -d postgres:18
NODE_ENV=test DATABASE_ENVIRONMENT=test \
  TEST_DATABASE_URL=postgresql://postgres:synthetic-acceptance-only@127.0.0.1:55439/aqlan_finance_test \
  node --import tsx scripts/test-finance-lifecycle.mjs
```

The runner reuses the project target policy and PostgreSQL major contract. It requires
both `NODE_ENV=test` and `DATABASE_ENVIRONMENT=test` in the original environment,
and rejects production classification, conflicting database aliases, PG connection
overrides, Railway markers, remote targets, query parameters and fragments before
constructing a client. It reads `server_version_num` and rejects non-18 servers
before global setup. Empty admin database and absent `aqlan_sec_http` checks remain
mandatory. The database name alone does not authorize the run. No DATABASE_URL
fallback is accepted; any supplied alias must equal the explicit test URL. Verify container identity and bindings before cleanup.

Limits: HTTP/server-rendered statement assertions do not prove browser behavior,
print layout, or an actual network transport failure; acknowledgement loss is
modeled by discarding the successful response and repeating the exact command.
No full-suite CI, production access, deployment, or merge was performed. This
candidate awaits dot review.
