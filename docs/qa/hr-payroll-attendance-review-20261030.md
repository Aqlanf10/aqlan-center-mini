# Attendance, leave and payroll review

Base: main b5540169. Compared Claude work branch 11668bd9; its payroll change translates CommissionLabLineageError. That backend is untouched here.

## Findings

HR-03 (confirmed presentation defect): the payroll summary labeled totalDeductionsMinor as deductions and absence, although calculatePayrollRun does not derive absence, lateness, unpaid leave or overtime adjustments. The approved limitation is documented in HR_MAIN_RECOVERY_20261015_AR.md. The summary now says recorded deductions and explains the limitation before approval. No automatic deduction policy is introduced.

Code trace: leave approval updates used/pending balances and writes on_leave attendance records. Cancellation reverses balances and removes only untouched generated attendance records; records with evidence/history survive and have their status recalculated. Payroll calculation uses resolved pay terms and commissions, not attendance deductions. This is a code review, not proof of every transactional path.

## Verification and limits

15 existing unit tests passed across attendance calculation, payroll arithmetic and payment confirmation. The new synthetic browser fixture loads the real payroll panel, intercepts all requests, verifies the disclosure and rejects writes/external requests. Local browser assertions passed in the diagnostic run, but browser shutdown stalled; do not label that run fully green. ESLint found no errors and two pre-existing unused-state warnings. No live database, employee, clinic data, staging or production was accessed.

## Isolated PostgreSQL follow-up

Executed on a freshly initialized PostgreSQL 18.6 cluster bound only to loopback, using Node 22.16.0 and Asia/Aden. No existing database, secrets or backup was reused. The local test server was stopped after verification.

- All six original financial-suite cases passed with the extended paid-leave/attendance/payroll checks.
- After adding unpaid leave, the three targeted lifecycle cases passed (annual November, annual January/year boundary, unpaid December); four unchanged financial cases were excluded by the targeted filter, not silently skipped as failures.
- Actual service calls create employees/contracts, record attendance, allocate/request/approve/cancel leave, calculate/recalculate/approve payroll. Tests verify balances, exact leave dates, retention of a real synthetic attendance day, unchanged net/deductions under current policy, stable run identity, repeated approval stability and refusal to recalculate approved runs.
- The original full financial suite also verifies real salary obligations, cashier-shift requirements, expense records, settlement and disbursement idempotency.

This validates the service/database cycle; it is not a full browser-to-live-server journey. No new application financial defect was demonstrated in these scenarios. Automatic payroll effects still require an explicitly approved policy (day/hour basis, holidays, paid/unpaid leave, overtime and retroactive changes) and coordination with Claude. Do not infer policy from old stored settings.

Browser teardown now owns a dedicated Playwright BrowserServer, terminates only that owned process, waits for disconnect and asserts exit. This avoids relying on the Windows headless-shell graceful-close handshake; no global browser/process-name killing or suppressed teardown exception is used.

Final local validation: the browser test passed including process exit/disconnection and teardown (exit code 0); TypeScript passed; ESLint had zero errors and one pre-existing unused-variable warning in the financial fixture. No merge or deployment was performed.
