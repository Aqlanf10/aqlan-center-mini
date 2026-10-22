# Supplemental appointment acceptance

## Status and source identity

- Final published application pin and local base: `0fd0cc7c6f167ea366de3aa69103058b0390bc3d`
  ([Draft PR #414](https://github.com/Aqlanf10/aqlan-center-mini/pull/414)).
- Application tree: `e50552a2bdafab243439595a2b026b16ac7f753e`.
- Hosted Chromium/PostgreSQL execution: **not run by local authoring**.
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

On the final pinned source with these four test/review additions, Node 22.23.3:

- Full `tsc --noEmit --incremental false`, `NODE_OPTIONS=--max-old-space-size=4096`: passed.
- Workflow guards plus existing guarded-browser-routes regressions: 29/29 passed
  (16 workflow cases, 13 route-lifecycle cases).
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
