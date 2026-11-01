# HR leave review — 2026-10-30

Base: main b5540169. Branch: codex/hr-leave-balance-input.

## Confirmed defects

- HR-01: the allocation form sent `1` for the valid number input `1e2` (100). Reproduced by rendering the real component in an isolated browser fixture and inspecting its POST body. Replaced truncating parseInt with Number plus finite/range validation. No balance writer or payroll calculation changed.
- HR-02: the balance endpoint defaulted to the host's calendar year. At 2026-12-31T22:00Z, the clinic is already in 2027 while a UTC host selected 2026. A regression test failed before the change. GET and POST now use the configured clinic time zone; explicitly supplied years remain supported.

## Boundaries and coordination

Reviewed leave form, leave/balance routes, and relevant allocation/request code. This is not a complete HR audit. Identity, payroll, attendance calculations, authorization, migrations and production data are outside these changes. The work-recovery branch has changes in hr.ts, hr-payroll.ts and identity readers; these files were not modified. Existing orthodontic edits remain in their separate checkout.

No production or staging requests, migrations, financial mutations or deployment were used for these fixes. Browser fixture requests are intercepted locally and synthetic. Unit route tests mock persistence. These tests do not establish end-to-end database or payroll correctness.

The initial Edge fixture run passed all six test bodies but timed out closing the browser. This is a test-environment failure, not a fully green run. Final verification results belong in the PR handoff.

## Remaining review

Attendance/leave/payroll integration, request retry behavior, employment termination, contracts and permissions require further review against Claude's current work before additional changes.

## Candidate follow-up: fractional allocation browser constraint

On candidate `fff3c794`, native number-input validation still defaulted to step 1 and blocked fractional allocations before submission. The existing writer accepts finite numbers in [0, 366], and the balance column is NUMERIC(5,2); it does not require whole days. Added `step="any"` to align the form with that existing validation without introducing a new precision/rounding policy or changing the server.

Real Chromium with the actual React component and intercepted synthetic requests reproduced three failures before the fix: 2.5, 0.01 and 365.99 all reported `stepMismatch: true`. After the fix, all 14 fixture tests passed. Accepted inputs 1e2, 2.5, 0, 366, 0.01 and 365.99 reached POST as their exact numeric values. Empty, -0.01 and 366.01 triggered native invalid events on submit and sent no POST. Existing read-lifetime and canceled-decision tests remained green. This fixture does not exercise a live database; final-head CI and live staging acceptance are separate evidence.
