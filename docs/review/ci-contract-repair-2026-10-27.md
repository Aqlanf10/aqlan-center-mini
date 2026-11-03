# CI contract-repair review — Aqlanf10/aqlan-center-mini

## Baseline and scope

Hosted run **40550697658** tested public head **58a317f1a84b8d318ea0faa8651265b9f85e8955**, merge **38fe3184d6a64028f1688c4309e3c10da6984091**, exact tree **15172104de9ebdd4a8a04771bccaca538ff12faa**. Its sanitized artifact reports **20 failed suites / 56 failed assertions**, alongside 246 passing suites / 1,845 passing assertions. Failure locations are evidence of where execution stopped, not proof of a root cause by themselves.

The table below accounts for all 56 baseline failures. It maps source-reviewed repairs, **not 56 verified resolutions**. Browser outcomes remain unverified locally.

## Failure-to-repair map

Suite names below omit the common `__tests__/security-http/` prefix.

| Baseline suite | Failed assertions | Current repair / preserved contract |
|---|---:|---|
| `clinical-visit-ortho-entry-ui.test.ts` | 7 | Returning patients use contextual change-only notes; first-visit numeric labels remain explicitly covered with `previousVisit:null`. Blank orthodontic work remains blocked; tests document today's work before review/sign. |
| `clinical-visit-pending-notes-ui.test.ts` | 1 | Actual product presentation fix: localize fetch `TypeError` instead of displaying “Failed to fetch”; preserve actionable validation errors and existing owner/lock/save boundaries. |
| `patient-workflow-clinical-draft-ui.test.ts` | 3 | Use returning-patient labels; explicitly model the exact read-only lab-capability GET. Retain draft/DOM ownership, prior-reference and forbidden-write assertions. |
| `ortho-adjustment-wire-defaults-ui.test.ts` | 3 | Assert empty-work rejection, then fill a documented review before submitting. Preserve wire, elastics and interval assertions. |
| `patient-ortho-real-react.test.ts` | 11 | Baseline responsibility selection uses an explicit administrator session and active-doctor DTO. Exact owned return-booking context reads receive fixed synthetic server-shaped evidence; wrong source/patient/method/origin remains rejected. Booking payload source/fingerprint assertions were added. |
| `legacy-onboarding-checklist-ui.test.ts` | 4 | Align current included-label wording and missing-funding `REVIEW_REQUIRED` classification; preserve late-read fencing and financial immutability. Compatibility-link funding remains covered where the current classifier supports it. |
| `ortho-followup-booking-default-built-page.test.ts` | 1 | Actual `/api/appointments` source refusal is HTTP 400 with `return_booking_source_changed`, unlike the separate rebooking endpoint. Preserve source refresh, unchanged raw draft and no-write checks. New real-HTTP witness verifies the boundary. |
| `phone-width-ui-journey.test.ts` | 5 | Each scenario receives a fresh patient identity; do not cycle retired patient numbers or weaken the database identity guard. Existing layout assertions remain. |
| `invoice-preview-state-journey.test.ts` | 2 | Multi-tooth surfaces are independent, not reset globally. Preserve each tooth's selections and explicitly test independence. |
| `invoice-quote-contract-ui.test.ts` | 2 | Use current patient-facing net-paid statement label; retain saved contract, amount and audit assertions. |
| `invoice-quote-statement-http.test.ts` | 2 | Same statement-label contract; explicitly exclude internal reversal wording. Real HTTP suite passed at `fb066f4`. |
| `invoice-tooth-chart-journey.test.ts` | 3 | Reachability probes deliberately deselect before testing the next tooth; retain multi-selection semantics and add independent per-tooth surfaces/price/provider/linkage evidence. |
| `patient-statement-historical-print-ui.test.ts` | 1 | Preserve payment and refund evidence under current patient-facing statement presentation rather than obsolete internal wording. |
| `ortho-compatibility-reference-http.test.ts` | 1 | Missing installment funding needs review, not an invented outside-contract charge; preserve unchanged financial state. Real HTTP suite passed at `fb066f4`. |
| `invoice-clinic-continuity-journey.test.ts` | 3 | Enumerate all treatment sessions with a LEFT JOIN: future sessions can exist without planned-visit IDs. Require the next real assigned visit after signing; do not manufacture visits or reuse stale IDs. |
| `reception-exact-checkout-ui.test.ts` | 2 | Add only exact fixture-visit return-booking context reads; keep unknown endpoints and writes blocked. |
| `reception-signature-handoff-ui.test.ts` | 1 | Same bounded checkout source-read contract; retain handoff assertions. |
| `walkout-verified-balances-ui.test.ts` | 1 | Same bounded source-read contract; retain verified-balance assertions. |
| `appointment-action-error-ui-journey.test.ts` | 1 | Isolate A/B patients per scenario: unique starting times alone do not prevent later nearby-booking interference. Keep overlap protections. New real-HTTP isolation witness passed. |
| `legacy-reconciliation-preview-built-page.test.ts` | 2 | Model the exact independent archive sibling GET with `migration_pending`, empty rows and no invented ready state or permissions. Unknown reads/writes remain blocked. |
| **Total** | **56** | **20 baseline suites accounted for; hosted browser confirmation still required.** |

## Source lineage

Clinical repair chain: `661d6fa` → `4cd9254` → `093a24a` → **`315cc03`**. Financial/clinic/checkout branch ends at **`27399ef`**; its consolidated equivalents are `6fe6aa0`, `3211ace`, and `a140f93`. Appointment-isolation source **`749045a`** was consolidated as **`fb066f4d875f93f8ba2d1b758b6c6cc5cd71a9b5`**. Archive-read repair then produced **`970180b4722755f47c244eeee6493a07e66ca259`**.

The subsequent reviewer-owned **`7ed18d38f5936c9202e34dc5d2d742c39437812f`** records the narrowly reviewed save-handler hash change and adds a regression proving that substituting the old error expression recovers the prior handler byte-for-byte. This is not a blanket hash refresh. The corrected checkpoint subsequently passed the sanitized full unit suite and type check described below.

## What has actually been verified

- **`661d6fa`:** the original save-catch expression failed the localized-network-error regression; the repaired helper and bounded-context fixture suites passed **16 tests / 2 files**. Full TypeScript checking passed.
- **`fb066f4`:** fresh built-app, isolated-database, browser-free HTTP execution passed **7 tests / 4 files**: statement SSR (2), compatibility reference (3), stale orthodontic booking source (1), and appointment scenario isolation (1). The stale-source witness used real context GET, audited responsibility PATCH, repeated identical stale POSTs rejected with 400/no appointment rows, then fresh context and exactly one 201 booking under the new doctor.
- **Browser suites: UNRUN locally.** Local Chromium execution was denied; it was not retried through a workaround, alternate IPC/ptrace route or other circumvention. HTTP and unit results do not establish layout, accessibility, real-browser ownership or all 56 hosted assertions.
- **`7ed18d38f5936c9202e34dc5d2d742c39437812f`:** sanitized Node 22 full unit execution passed **778 files / 13,121 tests**, and the full 4 GiB TypeScript check passed. Source digest `247402a48b6821aaea8b107aaa96d338c8c6672eace5a807ba4993112358e36d` and clean source were rechecked. The previous run at `970180b` had one genuine stale reviewed-handler hash failure (777 files / 13,119 assertions passed); that evidence is retained, not attributed to environment warnings.
- Full repository ESLint at the same `7ed18d` checkpoint exited 0 with **0 errors / 215 warnings**, without fixes or new exclusions. Existing `.mjs` and `.d.mts` exclusions mean those files are not claimed as lint-validated. Evidence: `final-contract-eslint-fpoyzI7i`.
- Fresh hosted browser CI remains a gate. No claim that all 56 browser failures are fixed, and no Production verification is inferred.

## Review boundaries and evidence

Repairs preserve financial integrity, canonical responsibility, retired identifiers, nonempty clinical documentation, ownership/late-response fencing and closed request guards. The primary product delta is localized save-error presentation; most other changes repair fixtures or expectations to match independently inspected current contracts. No Production mutation, publish, merge or deployment is claimed by this report.

Sanitized evidence references:
- `recovery-evidence-20261027/hosted-58a317f1-artifacts/summary.md` and `http-security-locations.json`
- `recovery-evidence-20261027/clinical-ci-661d6fa/`
- `recovery-evidence-20261027/ci-contract-http-owned-apPTm3lS/` (source checkpoint and test summary)
- `recovery-evidence-20261027/final-contract-sanitizedchecks-TFviqXl1/` (final units, types and unchanged-source proof)
- `recovery-evidence-20261027/final-contract-sourcechecks-isaaeaiY/` (retained prior hash-contract failure)

This report contains no credentials, raw logs or patient data. It was prepared outside the candidate worktree, then updated with verified final validation. Public upload remains held pending the outstanding user confirmation; no merge or Staging/Production deployment occurred.
