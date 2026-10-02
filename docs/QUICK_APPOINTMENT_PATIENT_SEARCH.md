# Quick appointment patient-search lifecycle

## Bounded defect and reproduction

Audited on 2026-10-02 UTC against remote main
`d1f94e683c7f78d54dc197c6533921b1fcbde4d8` and its local tree-equivalent
`d08c22f9a945acfa08dcc07ee0eddefd77131ce5`
(`e141294888367df710432da4188d31bc28b918df`).

`QuickAppointmentModal` previously canceled only its 300 ms debounce timer. Once
a search had started, an older response could replace a newer query's matches,
erase its existing-patient choice, or repopulate suggestions after clearing the
input. Already-rendered previous-query choices also remained clickable while a
new lookup was pending. Closing the mounted modal did not cancel its search, and
reopening an unchanged query did not trigger a fresh lookup.

The independent tests-only reproduction had six failing cases and two passing
preservation controls. All 11 existing submission tests passed on that baseline.
The booking acceptance explicitly selects the current-query patient and checks
that the appointment request contains that patient's ID with no patient-create
request. A synthetic baseline request trace is not evidence of historical or
Production duplicate records.

## Correction

- Clear old suggestions whenever the query, selected patient or open state changes
- Search only while the modal is open, no patient is selected and the trimmed
  query has at least two characters; retain the existing 300 ms debounce
- Abort and clear the timer on effect cleanup, including close and unmount
- Check cancellation after JSON parsing, so a stale response cannot commit even
  when its transport or already-started body parsing does not stop immediately
- Reopening a retained, eligible query starts a fresh lookup

The selected patient and booking payload remain authoritative. The submission
lock from PR181 and disabled fieldset from PR184 are unchanged. A patient is still
selected explicitly; this change does not auto-select a match or forbid creating
a new patient from an unselected name. It does not add server-side deduplication,
idempotency, or historical cleanup.

## Verification boundary

- `__tests__/quick-appointment-patient-search.test.ts`: 16/16 pass, exercising the real component
  with committed hooks, synthetic fetches and effect cleanups. The fetch mock
  deliberately ignores abort so stale response and delayed JSON guards must work
- Coverage includes newer results followed by older empty or nonempty responses,
  clearing previous choices before the debounce, minimum query length and exact
  debounce, selection and correct booking ID, close before fetch, retained-query
  reopen, changed-query reopen, response/JSON failure recovery, delayed JSON after
  query change/clear/close/selection, and no state update after unmount
- All 11 existing submission cases remain green; related appointment, waiting-list
  and schedule suites pass 224/224 tests across 11 files. Root review independently
  passes the 27 search/submission cases; focused ESLint, focused TypeScript with
  Next ambient types, full-repository TypeScript and `git diff --check` pass
- `__tests__/security-http/quick-appointment-patient-search-ui.test.ts` adds four
  built-app cases under the existing isolated HTTP harness: current-query explicit
  selection and correct booking ID at desktop/mobile, edit/clear with a late body,
  and closed-session response rejection plus fresh retained-query reopening.
  A browser-local deferred fetch shim deliberately ignores cancellation to check
  the post-body guard. API traffic is fulfilled or blocked by the fixture; no real
  patient or booking is created. No layout change or screenshot claim is involved
- Independent implementation and browser-test source reviews found no blockers.
  Exact-head full CI, merge and Railway Production
  verification remain release requirements. Local browser execution is blocked
  by the already-established executor socket restriction; no local browser pass
  or Production patient-search session is claimed

There are no API, database, schema, permission, clinical or financial changes.
This work does not establish broader cross-patient navigation or visit-relink
safety and does not close those separate verification gaps.

## Local integration refresh after PR187

Refreshed locally onto released main
`a731f9d1ff6c4b79b27473e0bd22eea62f2ac6aa`, using its source-equivalent local
`79241e8` (tree `9c3c2136464dee25000c0d255521c9d30449d644`). The search
implementation and both regression files are unchanged from the reviewed version.
The prescription component, tests, documentation, workflow screenshot artifact and
all previously released matrix rows are preserved.

- Sequential affected-unit rerun: 224/224 pass across 11 files
- Focused ESLint and focused TypeScript with Next ambient types pass again
- The first overlapping attempts ended with one unexpected Vitest worker exit
  (215 completed tests, no assertion failure) and a full TypeScript process killed
  with exit 137. Those incomplete attempts are not passes. The sequential unit
  rerun completed; the later full TypeScript retry was stopped with exit 130
- The earlier full TypeScript pass above covers the pre-refresh reviewed tree.
  No refreshed full-repository TypeScript or built-browser pass is claimed;
  exact-head full CI remains mandatory before release
