# PR #330 — pending-note regression and visual refinement

Failed head: `2d1c9cb28bcc45987f51412b071817b9b4cdc238`.
Failed [CI run 38497563800](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38497563800), job `115636732267`, step **HTTP security integration tests**.

## Failure evidence and cause

Both GitHub annotations identify `__tests__/security-http/clinical-visit-pending-notes-ui.test.ts:292:38`:

- `retains notes and unlocks after a POST rejection, allowing a corrected retry`
- `retains notes and unlocks after a POST network failure, allowing a corrected retry`

Expected `f.alerts.count()` = **1**; actual = **0**. The same unmodified head reproduced both failures locally, with the other three cases passing. This was not diagnosed from an assumed timeout: the assertion was immediate, and the preceding draft-content and lock-state checks had passed.

The fixture scoped alerts to `#visit-notes`' immediate parent. Compared with integration base `175957f4e074d28b819d00a51f3f1e6d53b3d78b`, the design added `visitColumns` and `visitNotes` wrappers. The error still renders at the `ClinicalVisit` root, outside that notes column. The base-to-failed-head diff in this component consists of the CSS import and those wrappers; it did not change the clinical reader, writer, ownership or permission checks.

The repair marks the existing owner-keyed root with `data-testid="clinical-visit-workspace"` and scopes the existing alert assertion to that root. It retains count, exact error text, all five notes, POST/GET locking, corrected retry and safe-request assertions, and adds an explicit visibility assertion. No test was deleted or disabled and no timeout or CI rule was changed. The two failing cases and then the complete five-case file passed locally against the optimized application build.

The full GitHub log archive could not be downloaded: `gh run view --log-failed` received HTTP 403 from the environment's download proxy. The job metadata and complete annotations were retrieved through the GitHub API. The local reproduction log is complete; it is not represented as the unavailable remote archive.

## Warning ownership found during visual verification

An intermediate attempt to show all warnings through the readiness area failed the existing navigation tests. A successfully authorized patient-record warning must remain visible even when readiness has not granted a clinical read or its GET fails. That attempted composition was discarded before commit.

The final composition retains the independently authorized patient banner and the existing readiness hook unchanged. The cockpit omits only text exactly matching the patient warning already displayed beside it. Distinct history warnings remain visible; no fuzzy matching merges diagnoses. Add/replace/remove tests check the current patient warning and the separate history warning, including the original viewport hit tests for **both** sources, failed canonical GETs, and unchanged ENDO drafts. Denied readiness never gains access from a local warning.

## Visual changes in this repair

- Visit-stage disclosure shares the action row, and patient header padding is reduced without fixed heights or clipped warnings.
- The original plan cards now precede their read-only financial-reference region in DOM/tab order. References remain complete in a responsive two-column region, with the same reader and permissions.
- Selected-plan progress uses a linear indicator of actual recorded procedures. Historical/unknown progress remains explicitly unknown.
- Summary has one collection action in its account section. Native currencies remain separate; detailed agreement/invoice values expand independently without introducing another writer.
- The four existing account regions share the desktop row; expanded treatment/history forms use full width. Closed disclosures and short balance cards no longer stretch into empty full-height panels.
- Mobile action targets remain at least 44px; clinical tooth geometry is not resized.

The 15-reference comparison gallery and runner evidence are updated in `evidence/final`. Remaining deviations are recorded in `PATIENT_PREMIUM_REFERENCE_REVIEW.md`; illustrative clinical data and financial relationships are never manufactured for visual similarity. No migration, financial engine, API authorization, staging service or production deployment was changed.


## Final local checks

- 58/58 cases across six HTTP/browser files passed after the final account/plan layout: all 15 scenes at three widths, pending-note failures, patient navigation/freshness, invoice settlement labels, read-only historical preview, and plan-payment permission/lifetime checks.
- The broader nine-file run passed 79/79 before the final presentation-only account/plan adjustments, including visit ownership, readiness denial, native review and More.
- Focused unit runs passed 101/101 for warnings/ownership and 69/69 for plan visibility/lifetimes. Typecheck, lint (0 errors, 185 existing warnings), optimized build, environment contract and money aggregation guard passed.
- The portable gallery verified 90 viewport/full-page image hashes and loaded all three width selections in Chromium without JavaScript errors. It includes 12 additional clinical detail captures and the 15 original references/difference maps.

See [runner results](evidence/final/repair-verification-results.txt), [the failed-head reproduction](evidence/final/pending-notes-before.log), [remote failure annotations](evidence/final/failed-ci-annotations.json), and [source/capture provenance](evidence/final/capture-context.json). Final GitHub CI is tracked by exact SHA on PR #330; local results do not replace it.
