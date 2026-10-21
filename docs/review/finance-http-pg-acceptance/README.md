# Synthetic invoice/debt acceptance — awaits dot review

Base: `e32efbaa15ef4996a8bc375a6ef01579683bab8a`, verified after fetching
`fix/ortho-canonical-financial-read` from `https://github.com/Aqlanf10/aqlan-center-mini.git`.
Independent branch: `test/finance-http-pg-acceptance`.

No application defect was reproduced by these journeys. This is a coverage-only
change, with no production code, migration, owner permissions, or currency changes.
No checkout test was changed. No browser or period-closing race was run.

## Executed evidence

2026-10-21 UTC, final verification on Node 22.23.3 (the repository engine), PostgreSQL 16.15 (official postgres:16 container),
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

Use a fresh disposable local PostgreSQL instance. Never point this at an existing
application server or production database. Install dependencies locally (`npm ci`)
and build the exact candidate (`npm run build`) first. Example synthetic setup:

```sh
docker run --name aqlan-finance-acceptance-synthetic \
  -e POSTGRES_PASSWORD=synthetic-acceptance-only \
  -e POSTGRES_DB=aqlan_finance_test \
  -p 127.0.0.1:55439:5432 -d postgres:16
TEST_DATABASE_URL=postgresql://postgres:synthetic-acceptance-only@127.0.0.1:55439/aqlan_finance_test \
  node scripts/test-finance-lifecycle.mjs
```

The runner rejects remote targets, absent URLs, nonempty admin databases, existing
`aqlan_sec_http` databases, query parameters, and Railway environment markers
before invoking the existing destructive global setup. It does not accept a
`DATABASE_URL` fallback. Verify container identity and bindings before cleanup.

Limits: HTTP/server-rendered statement assertions do not prove browser behavior,
print layout, or an actual network transport failure; acknowledgement loss is
modeled by discarding the successful response and repeating the exact command.
No full-suite CI, production access, deployment, or merge was performed. This
candidate awaits dot review.
