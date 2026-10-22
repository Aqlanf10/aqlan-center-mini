# Supplemental appointment acceptance

## Status and source identity

- Final published application pin and local base: `42b91977ea31bcbe61086f5f51717590a05f0ced`
  ([Draft PR #414](https://github.com/Aqlanf10/aqlan-center-mini/pull/414)).
- Application tree: `7bea78d71e0c73ace70abd8b2fe447033c73299d`.
- First hosted attempt `39709737846` on acceptance `636bc3df44b8f8fc7fb21e9a61c1401546f57654`
  failed at the environment-contract step, before browser execution.
- Prior hosted run `39711640521` succeeded on application `0fd0cc7c6f167ea366de3aa69103058b0390bc3d`
  with acceptance head `73c6d443` after the npm11 setup correction.
- Fresh hosted acceptance on `42b91977ea31bcbe61086f5f51717590a05f0ced`: **pending**.
  The earlier success is not acceptance of this new SHA. No local Chromium/PostgreSQL execution.
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

- Full compilation was not rerun for this repin while another worker owns the
  compiler. The last full check passed on prior app `0fd0cc7c6f167ea366de3aa69103058b0390bc3d`.

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
This is separate from the eight browser journeys and does not substitute for a
fresh hosted run on the new immutable pin.

The repin changes the workflow's exact SHA, the matching static assertion, and
these evidence notes. The connected journey, npm11 setup, source-isolation checks,
read-only permissions, and outbound interception remain unchanged.
