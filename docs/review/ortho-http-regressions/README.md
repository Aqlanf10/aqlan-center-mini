# PR #371 HTTP acceptance follow-up

Baseline: `e32efbaa15ef4996a8bc375a6ef01579683bab8a` on
`fix/ortho-canonical-financial-read`. Work is isolated on
`fix/ortho-http-regressions`; the shared source branch was not changed.

## Findings and bounded patch

The baseline's hosted compatibility-panel tests still wait for content inside
now-collapsed details, assert the removed “package / adjustments included” copy,
and expect the removed create-plan link. The checklist test additionally tries
to relink after unlinking, although the parent deliberately permits only existing
compatibility links. These are directly demonstrable test/product contract
mismatches, not a reason to restore the old financial-authority claims.

- Open the compatibility details explicitly before inspecting its read states.
- Assert the compatibility-only label and independent coverage guidance; preserve
  delayed/error/denied/malformed/foreign-patient handling, real backend recovery,
  viewport/occlusion checks and unchanged financial snapshots.
- Preserve unlink/error/retry/stale-response fencing. Restore only the original
  owned synthetic fixture through its DB connection, then use the real parent
  refresh; do not reintroduce a UI action that manufactures a new plan link.
- Add browser-free HTTP coverage of the actual synthetic fixture: a recorded old
  schedule has no canonical invoice/historical source, an accountant is denied
  by the existing role gate, and unlink changes classification without creating
  debt or a clinical bridge. Existing compatibility classification is unchanged.

No application logic, schema, financial writes, timeout, test selection/config,
artifact upload configuration or statement footer is changed. Hosted browser
coverage remains mandatory. No local Chromium was launched.

## Local evidence

Owned container `ortho-http-pr371-pg18`, image `postgres:18-alpine`, PostgreSQL
18.6, bound only to `127.0.0.1:55431`; Node 22.23.3, npm 11.21.0. HTTP harness
creates and drops `aqlan_sec_http` on this disposable server. PostgreSQL tests use
its disposable `aqlan_p1_test`. No shared or Production database was used.

Passed:

- Locked dependency install and baseline production build.
- Baseline HTTP: `ortho-package-http`, `ortho-baseline-http`,
  `ortho-patient-scope-http`: 28 tests.
- Added `ortho-compatibility-reference-http`: 3 tests.
- Units: `ortho-package-read-state`, `legacy-onboarding-checklist-refresh`,
  `ortho-invoice-linkage-read-witness`, `ortho-financial-source-contract`,
  `ortho-financial-read-snapshot`: 122 tests.
- PostgreSQL: `ortho-financial-reference-read` and
  `historical-document-financial-reference`: 6 tests.
- Typecheck, ESLint on all three changed test files, and `git diff --check`.

Commands use the repository's unchanged Vitest configurations with explicit file
arguments. The historical PostgreSQL suite initially stopped in setup because
SESSION_SECRET was omitted; supplying the CI synthetic placeholder resolved it.
The new HTTP test's initial expectations were corrected to match the existing
proxy's exact private/no-store header and finance-role denial; these were test
authoring errors, not baseline application regressions.

Local raw logs: `/workspace/reviews/pr371-http-repair/` (not committed).

## Remaining gates / access limitations

The original CI 39515456162 / job 118946422981 failure assertions are unavailable.
Standard `gh run view --log-failed` returned Forbidden for the Actions log
artifact. A standard `gh api` job read returned HTTP 401 Bad credentials; the
GitHub log connector returned Transport closed. No raw browser log URL was
retried and no access control was bypassed.

Run the complete hosted CI on the new head, including both revised browser
journeys and the untouched orthodontic prescription truth journey. Missing
artifact uploads alone do not establish those tests' failing assertions. In
particular, prescription screenshot geometry is unresolved and must not be
claimed fixed or weakened without hosted evidence. The local passing subset is
not a substitute for the complete HTTP/browser gate, review, merge or deployment.
