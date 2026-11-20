# Private integration: patient numbering, synthetic-only

Exact base `97724c2ef6d0a85819648111d2fa617445943d62`. This integration composes
reviewed local sources only (728be51a, fb66072e, 2df9e63e, ff4cee93, f90935b3,
2a135c8b, 4776237d). Do not upload as a release or push review branches.
No numbered schema migration, managed owner binding, credential modification,
real backup, actual Staging or Production environment was used.

The four actual patient-allocating inserts in `lib/db.ts` bind an identifier
supplied by an explicitly installed request-local scope. Without that scope
they use the unchanged legacy SQL. The synthetic installer takes the same
client already inside the patient's insertion transaction, after its existing
patient-import lock. The singleton config row serializes these inserts with
owner save and sidecar export. A scoped failure never falls back to legacy.
No application route, settings screen, environment variable, startup hook, or
default provider installs the scope. Test routes exist in a Node loopback
harness under tests only; they are not Next routes.

## Verified on owned synthetic PostgreSQL 18.6 and Node 22

An isolated HTTP operator saved A / 1500 through the actual preview-bound
controller, then repeated the exact body: one command, one audit, one receipt.
An ordinary admin using the same body got 403. Actual registration issued
`A-01500`; concurrent walk-in, booking confirmation and CSV import issued
`A-01501` to `A-01503` without duplicates. Reopening/reconfirming/reimporting
did not allocate a second patient. Existing `P-07000` and the legacy counter
were unchanged. Registration outside the fixture scope still used `P-07001`.
The verified sidecar admits its exact independent fixture witness and
refuses the old sidecar as well as missing evidence.

The genuine Playwright test is maintained separately from the HTTP run and
must pass before acceptance. Chromium in this executor aborts at startup
before any page load (`process_singleton_posix.cc: socket() failed: Operation
not permitted`, AF_UNIX). No bypass, browser claim or substitution is implied.
The harness exercises the real React numbering component and actual DB
functions when Chromium can run; it is not the released Next settings/auth UI.

## Hold

Reserve and review a project migration after checking active branches and
registry; none was picked. Add governed production owner identity and real
session/authorization integration only after the account-control evidence is
reviewed. The current example verifies A below the legacy P history. Before
multi-prefix activation, reconcile cold startup's legacy projection: currently
it still scans numeric parts of identifiers across prefixes in legacy mode,
so a high non-P number must not accidentally affect P after activation.
The official backup gate remains held without an independently trusted
durable freshness witness and full product integration of the JSON sidecar,
parameterized restore and activation fencing. Existing legacy snapshots do not
prove a new namespace or source freshness.

Repro (explicit owned test target only):
```sh
npx vitest run --config vitest.config.numbering-browser.mts -t 'separately exercises real HTTP'
npx vitest run --config vitest.config.numbering-browser.mts -t 'actual Playwright UI'
```

## Reproducible verification checkpoint

- Node 22.23.3; Next.js 16.4.5 `npm run build` exited 0 with TypeScript,
  static generation and a standalone server; no DB or Railway settings.
  The baseline migration loader still warns about broad file tracing.
  The narrow synthetic harness/config exclusions were checked against the
  actual standalone files and built route manifest; neither contained the
  harness files/config or any synthetic controller/fixture route.
- Focused unit/component/API: 309 passed. Focused PostgreSQL: 59 passed
  (legacy registration, product/administrative backup restore, owner
  revalidation/account protections, allocator and recovery projection).
  Native synthetic pg_dump/restore: 8 passed separately. Real HTTP scenario
  passed separately. Application backup tests are not a verified actual
  Staging restore. Playwright did not reach a page in this executor.
- User-visible test acceptance, independent source review, governed real
  owner binding, migration reservation, and backup/activation integration
  remain required. No known hold was waived.

Independent review corrections: isolated browser/HTTP proof excluded from default
Vitest collection; prove actual connected database name plus catalog identity
before application schema startup. Allocator refuses autocommit even if passed
a structurally compatible pool: the row lock must assign the same transaction
ID that is checked again when consuming nextval. 18 PG adapter/projection tests
and the real HTTP scenario passed on the corrected source, including unconsumed
legacy P after a pool/autocommit attempt. The exact rebuild passed and again
omitted harness files and routes. Normal Chromium with its sandbox requested
still aborted at the same OS socket restriction, before loading any page.
