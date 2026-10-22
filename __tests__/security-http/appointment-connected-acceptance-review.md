# Supplemental appointment acceptance

## Status and source identity

- Final published application pin and local base: `a58e7fbd37e7ab6a029a385367ee602ac1d0d9ba`
  ([Draft PR #414](https://github.com/Aqlanf10/aqlan-center-mini/pull/414)).
- Application tree: `ccd304ba6fe63dfe029df095f533d8810672006f`.
- First hosted attempt `39709737846` on acceptance `636bc3df44b8f8fc7fb21e9a61c1401546f57654`
  failed at the environment-contract step, before browser execution.
- Prior hosted run `39711640521` succeeded on application `0fd0cc7c6f167ea366de3aa69103058b0390bc3d`
  with acceptance head `73c6d443` after the npm11 setup correction.
- Root also reports successful hosted acceptance from #415 head `922f` on
  application `42b91977ea31bcbe61086f5f51717590a05f0ced`. This remains historical evidence for that exact app pin.
- Root reports successful hosted acceptance from #415 head `a3eb` on
  application `4286e1047eb262f5a1ececcb3fd86c0dfaf12cd6`. That result is historical evidence for the old pin only.
- Fresh hosted acceptance on `a58e7fbd37e7ab6a029a385367ee602ac1d0d9ba`: **pending**.
  None of the prior successes accepts this new SHA. No local Chromium/PostgreSQL execution.
- Dedicated review branch: `review/appointment-browser-acceptance-hosted`.
- Review base: `integration/nonfinancial-20261022`.

The single `FINAL_APP_SHA` value is the verified immutable published application
head after the appointment prerequisites were composed. The live base checkout
must equal that pin. The separate acceptance checkout must
match the event's exact head SHA. Only
`__tests__/security-http/appointment-connected-acceptance.test.ts` is copied into
the app checkout. A changed runtime/build file or any other untracked path fails
before the build. The workflow itself and its local guard tests are not runtime
overlays. Do not merge this diagnostic branch into the application branch.

## Reused execution model

This follows the existing #386 app-head-pinned acceptance model. It uses the
existing `vitest.config.security.mts`, `_global-setup.ts`, `_server.ts`, and
`guarded-browser-routes.ts`, not a new runner or a mocked application. The pinned
app is built normally and the existing harness launches its standalone server,
seeds synthetic role sessions, creates `aqlan_sec_http`, and tears it down.

GitHub Actions permissions are `contents: read`; checkout credentials are not
persisted. PostgreSQL 18 is an isolated loopback-bound service, with explicit
host/port/database/username and major-version verification. There are no Production
connections, Railway changes, deployment steps, real credentials, external
messages, artifact uploads, raw-log retrieval, or local Chromium workarounds.
Full product CI remains separately mandatory.

## Eight connected cases

1. Open the real clinic-hours editor, reject overlap in the UI and real HTTP,
   reject a partial tuple, then save a valid morning/evening tuple. Verify all four
   canonical values, shared PostgreSQL transaction ID and timestamp, and four audit
   entries. Failed requests must leave values, versions, transaction IDs and audit
   counts unchanged.
2. Open the doctor's actual daily schedule, bind its real response and rendered
   links to the assigned appointments, exclude the other doctor's patient, and
   reject a client-selected doctor override through HTTP.
3. Click a WhatsApp draft only behind a preinstalled context-wide interceptor.
   Verify no reminder stamp or PATCH, dismiss the native confirmation and verify
   again, then explicitly attest and verify the exact submitted snapshot, canonical
   timestamp, rendered badge, and persistence after reload.
4. After the board renders, reschedule through the real HTTP writer on another
   logical device. Confirm the stale displayed snapshot and require 409, visible
   refusal, unchanged canonical row, and no reminder stamp.
5. Repeat the stale-snapshot journey after actual HTTP cancellation.
6. At 390px, open a patient summary with real upcoming and closed rows plus an
   unrelated patient's row. Verify canonical dates and time attributes, group
   separation, intercepted draft, explicit reminder, persisted stamp, and round
   trip through the history view. Reads use the existing patient endpoint with
   `?projection=appointments&view=upcoming|history`. Closed and unrelated records
   remain unstamped.
7. At 390px, cancel through HTTP after the patient panel has displayed its row.
   Require stale-confirmation 409 and the refusal notice, canonical refresh out of
   upcoming, then the closed row and its real cancellation reason in history.
8. Through real HTTP, reject future absence, future past-resolution actions, and a
   missing reminder snapshot without status-log or row changes. Verify an actual
   prior-day absence closure and its actor-bound canonical status-log entry.

Before taking the baseline, reuse the established
`receipt-correction-ui-journey.test.ts` synthetic invoice and matching-line setup
(100000 YER minor, quantity 1, zero discount). Require nonzero `invoices` and
`invoice_items` counts. Use that same synthetic patient in the patient-panel
journey, so the real patient summary reads an existing financial history while
appointments are displayed and confirmed. No payments, shifts, or journals are
manufactured just to populate other tables; those five tables may remain empty.

After every case, compare complete-row count/hash fingerprints for seven financial
tables: invoices, invoice items, payments, expenses, cashier shifts, manual
journals and manual journal lines. This is non-mutation evidence for these tables,
not financial workflow acceptance or a claim to cover every financial table.

Every browser context installs origin/mutation routing before any page or popup.
Only the exact inspected synthetic `https://wa.me/...` draft navigation is expected,
and it is aborted before transmission. All other external requests and unexpected
writes fail the journey. Service workers are blocked. No API responses are mocked;
there are no fixed-delay sleeps or weakened fallback expectations.

A recorded reminder is explicitly **staff attestation**, never WhatsApp delivery
proof. Canonical SQL assertions, not only UI notices, determine success.

## Local static evidence

On the newly pinned source with these four test/review additions, Node 22.23.3:

- Full compilation was not rerun for this pin-only handoff. This worker's last
  full check passed on prior app `0fd0cc7c6f167ea366de3aa69103058b0390bc3d`.

  Command: `tsc --noEmit --incremental false`, `NODE_OPTIONS=--max-old-space-size=4096`.
- Workflow guards, existing route-lifecycle regressions, and environment-parity
  regressions: 104/104 passed (17 workflow, 13 route-lifecycle, 74 environment).
- Targeted ESLint on both added TypeScript files: passed.
- YAML parsed as one read-only job with the exact final application pin.
- `git diff --check`: passed; only the four acceptance files differ from the pin.
- No local PostgreSQL instance, application server, or Chromium was launched.
- The eight connected journeys and populated financial fingerprints remain
  **hosted execution pending**, not locally validated browser/database evidence.


`appointment-browser-acceptance-workflow.test.ts` executes the actual overlay Bash
with synthetic Git repositories. It covers allowed test-only composition, wrong or
unresolved application pins, wrong probe/branch, changed runtime files, unexpected
untracked inputs, symlink probes and untracked probe bytes. It also checks Bash
syntax, hosted containment and no-mocking/no-sleep invariants. Targeted lint and
YAML parsing are separate checks. Neither these checks nor TypeScript compilation
constitutes real browser acceptance; only a successful run on the final exact app
SHA does.

## Environment setup correction

The first supplemental workflow omitted the npm upgrade already present in the
pinned application's product CI. Its Node 22.23.3 distribution bundles npm 10.9.9,
whereas `CI_REQUIRED_NPM_MAJOR` requires npm 11 whenever `CI=true`.

A clean local environment using the same workflow values and the unchanged
`npm run verify:environment` command reproduced exactly one failure:
`[npm.ci-major]`, exit 1. Using the existing real npm 11.9.0 with the same
Node 22.23.3 and other values passed, exit 0. The verifier is static and opened
no PostgreSQL connection. No raw GitHub logs or artifacts were accessed.

The correction adds the existing product-CI command `npm install -g npm@11`
before dependency installation. A regression binds this step to the live npm
major contract and requires setup → npm upgrade → dependencies → unchanged
verifier → build ordering. The verifier is not removed or weakened, the app pin
is unchanged, and no connected-journey expectations or browser interception
rules changed. Hosted run `39711640521` subsequently passed on the prior app pin.
The new application SHA still requires its own passing hosted acceptance run.

## Test-fixture-only application repin

Application `42b91977ea31bcbe61086f5f51717590a05f0ced` changes only three synthetic
aging lines in `__tests__/security-http/referral-arrival-http.test.ts` relative to
`0fd0cc7c6f167ea366de3aa69103058b0390bc3d`. The application runtime tree is unchanged.
The fixture now puts the absence target in the past rather than assuming today's
08:00 appointment is already eligible before that time. Root reported the focused
real-HTTP comparison as 2 passing/3 failing before and 20/20 passing after the fix.
This was separate from the eight browser journeys. Root subsequently reported
#415 head `922f` passing on this `42b91977` app pin; that does not establish
acceptance of any later application SHA.

The repin changes the workflow's exact SHA, the matching static assertion, and
these evidence notes. The connected journey, npm11 setup, source-isolation checks,
read-only permissions, and outbound interception remain unchanged.

## Composed application repin

The previously pinned application `4286e1047eb262f5a1ececcb3fd86c0dfaf12cd6` included the
reviewed doctor-bookability, patient-history index `0067`, planned-visit lifecycle,
DATE backup preservation, and unique-consent fixture changes. The acceptance
branch is rebased onto that exact composed commit, retaining its original parents
and application tree rather than copying or replacing runtime source.

Root reports 390 unit tests, 248 PostgreSQL tests, full TypeScript compilation and
lint passing on the local union. The reported 657 HTTP tests in 93 files
passed on the #418 runtime plus fixture, not on the complete union. These results
were separate from hosted browser acceptance. Root subsequently reported #415
head `a3eb` passing on `4286e104`; that success is not acceptance of later source.

Inspection found no hardcoded migration/index-registry chain in the acceptance
workflow, its guard tests, or connected journey. The existing harness initializes
the schema from the pinned app, including its current registry and index. No
older-chain assertion was removed, weakened, or bypassed.

Only the exact pin, its matching guard assertion, and this evidence record change
for this handoff. The journey remains byte-identical, including populated financial
fingerprints and outbound interception. npm11 setup, app/probe SHA checks, the
single permitted test overlay and read-only permissions remain in place.

## Bootstrap and test-interceptor repair repin

The current application pin `a58e7fbd37e7ab6a029a385367ee602ac1d0d9ba`, tree
`ccd304ba6fe63dfe029df095f533d8810672006f`, has parent
`4286e1047eb262f5a1ececcb3fd86c0dfaf12cd6`. Its seven-path delta contains the
reviewed bounded-CASE counter-identifier bootstrap repair and test-only patient
projection interceptor repairs, plus their regressions. These are application
source changes, so prior acceptance on `4286e104` cannot certify the new pin.

Root reports 312 combined unit tests, source build, TypeScript compilation,
20 PostgreSQL tests and 657 HTTP tests passing on the repaired source. These are
separate release checks, not fresh hosted browser evidence. The eight connected
acceptance journeys still require a successful hosted run on `a58e7fbd`.

This acceptance handoff changes only the pin, matching static guard, and evidence
notes. It adds no runtime repair or test interceptor. The four-file supplement is
rebased onto the exact new application commit; the journey bytes, npm11 setup,
strict app/probe SHA verification, single-test overlay, read-only permissions,
financial fingerprints and outbound interception remain unchanged.
