# Routine adjustment visit — measured before and after (6838132093)

Owner request: test a routine adjustment visit from opening the case to saving it, and record the number of
navigations and steps before and after the change. Do not claim speed without evidence.

## Method

- Test: `__tests__/security-http/ortho-routine-visit-steps.test.ts`. The same script ran on both builds.
  - **Before:** the staging head `4d85fb69`.
  - **After:** the integration branch `feat/claude-integration-finance-ortho-20261112`, built at `0daad350`.
- Setup uses the real HTTP owners with synthetic data only: intake, assessment, a clinician-reviewed
  problem, strategy, explicit treatment start, and reception opening today's visit. One earlier session four
  weeks ago (elastics Class II, interval 4 weeks) is inserted directly, because the API records sessions on
  today's date.
- **Counted:** the doctor's own actions (clicks and field entries) and the browser's main-frame navigations.
  The run starts at the patient's orthodontic tab.
- Widths: 390px (phone) and 1280px (desktop). Arabic locale, Asia/Aden time zone.
- Evidence (synthetic screenshots and JSON): `.settings-ui-artifacts/ortho-routine-visit/{before,after}-{case,form,saved}-{390,1280}.png`
  and `{before,after}-steps.json` in each build's worktree. These are not committed, because generated
  evidence stays out of the repository.

## Result

| | Before (staging) | After (integration) |
|---|---|---|
| Doctor actions to a saved session | 3 (record a session → type what was done → save) | 3 (same) |
| Navigations | 2 | 2 |
| Session lands in today's open visit | yes | yes |
| Carried-over regimen saved unchanged | yes (Class II, 4 weeks) | yes (Class II, 4 weeks) |
| Source of carried-over values shown | **no**: elastics and interval are prefilled silently | **yes**: "recorded in the session of <date>; change it if it changed today" and "as in the session of <date>" |
| Case sections at 390px | 5 one-word tabs (labels cut to their first word) | 5 full labels in one row, in lifecycle order (records and diagnosis → plan → follow-up visits → retention → saved study) |
| Workup entry for a case in treatment | step 0 (start of the setup) | follow-up visits section; assessment-phase cases still open at the summary |

## Reading

- The routine visit was already short on staging: it opens on the visits section and needs three actions.
  The change does not shorten it, and this record does not claim that it does.
- What changes is that values carried over from the last session now show their dated source, so
  "unchanged" is visible rather than assumed (6838132093: "معلومة الزيارة السابقة مصدر مؤرخ").
- The phase-dependent workup entry removes a detour only when the doctor opens the full workspace from an
  active case. It is not part of the routine three-action path above.

## Owner directive (#483, 2026-11-13 23:05 UTC)

> خطوات جلسات الشد ما اريد تغيريها انا مرتاح بها واعمل بها يوميا

The steps and order of the adjustment session stay as they are. Reducing or reordering them is not a goal;
work on this path is limited to fixing defects and making data clearer. Verified on the integration head:
- The session form keeps staging's field order (wires, elastics, what was done, photos, date, interval).
- The routine path is the same 3 actions and 2 navigations.
- Additions are text only (the dated source of carried-over values) or come from #539 (optional "remove
  wire" checkboxes, unchecked by default).
