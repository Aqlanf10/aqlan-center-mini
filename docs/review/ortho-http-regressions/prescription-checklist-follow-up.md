# Prescription layout and post-unlink disclosure acceptance

Exact baseline: `af709ae57c5efbb52d70998dac751f3c07df0d7c` (#371).
New isolated branch: `fix/ortho-prescription-checklist-acceptance`.
No changes to closed #377, shared #371, or other active heads.

## Supplied normal annotation evidence

Parent supplied identical observations from #373 run 39529150972 / job
118990773575 and #379 run 39528400476 / job 118988355865:

- `ortho-prescription-truth-built-page.test.ts:99:24`, invoked at 204:39:
  full case bottom 1025 exceeds 1001 at 1280px, and 1011 exceeds 845 at 390px.
- `legacy-onboarding-checklist-ui.test.ts:163:83`: both widths time out after
  30000ms waiting for agreement text `لا يوجد رابط خطة أقساط قديم` after unlink.

Artifact absence is downstream evidence, not an additional defect. No denied
raw log was fetched or retried; no local Chromium was launched.

## Diagnoses and incremental changes

The card overflow is real. PatientOrtho places the full financial reference and
onboarding panels before the clinical prescription. These expand even for the
fixture with no linked financial source. Prescription view now groups those
unchanged readers under a native, keyboard-operable disclosure labelled
`مرجع الحالة المالي وشمول الشدّة`, with a minimum 44px summary target. Other
pillars keep those panels expanded. The label makes no funding or coverage claim;
role gates, error/refusal rendering, financial readers and clinical content remain
unchanged. No text is shrunk, clipped or removed. Details remain mounted inside
the disclosure and are accessible on expansion.

The post-unlink wait is obsolete visibility handling. A confirmed change invokes
load(), which returns the loading workspace before rebuilding the case card.
Native compatibility details therefore remount closed. The test now proves the
owned case's plan_id is null and the disclosure is closed, then reopens it before
checking the visible unlinked text. Existing error/retry, late-read fencing,
financial snapshots, single allowed unlink write and no-new-link checks remain.

The prescription browser test additionally opens the financial disclosure by
keyboard, verifies its financial region (and active-case checklist), measures the
44px target, and closes it before the original full-card geometry checks. All
original 79px top, viewport-bottom, text exposure, font size, control dimensions,
role/non-mutation, real-read and prescription assertions remain unchanged.

## Validation and limits

Node 22.23.3:

- 161 tests passed across patient-ortho-read-safety,
  legacy-onboarding-checklist-refresh and ortho-package-read-state.
- Typecheck passed.
- Targeted ESLint: zero errors, four existing useMemo dependency warnings in
  PatientOrtho (outside changed logic).
- Production build passed; diff whitespace check passed.

Local logs: `/workspace/reviews/ortho-prescription-checklist-acceptance/`.
No database or Production writes were needed for this layout/test-only change.

These local checks do not prove pixel geometry. Exact 390px/1280px geometry and
post-unlink behavior still require the unchanged strict hosted acceptance gates
plus the new disclosure interaction checks. Keep the new PR Draft for parent
review/integration; do not treat it as fully verified until hosted CI passes.
