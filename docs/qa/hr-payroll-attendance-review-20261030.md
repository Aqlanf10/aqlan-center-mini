# Attendance, leave and payroll review

Base: main b5540169. Compared Claude work branch 11668bd9; its payroll change translates CommissionLabLineageError. That backend is untouched here.

## Findings

HR-03 (confirmed presentation defect): the payroll summary labeled totalDeductionsMinor as deductions and absence, although calculatePayrollRun does not derive absence, lateness, unpaid leave or overtime adjustments. The approved limitation is documented in HR_MAIN_RECOVERY_20261015_AR.md. The summary now says recorded deductions and explains the limitation before approval. No automatic deduction policy is introduced.

Code trace: leave approval updates used/pending balances and writes on_leave attendance records. Cancellation reverses balances and removes only untouched generated attendance records; records with evidence/history survive and have their status recalculated. Payroll calculation uses resolved pay terms and commissions, not attendance deductions. This is a code review, not proof of every transactional path.

## Verification and limits

15 existing unit tests passed across attendance calculation, payroll arithmetic and payment confirmation. The new synthetic browser fixture loads the real payroll panel, intercepts all requests, verifies the disclosure and rejects writes/external requests. Local browser assertions passed in the diagnostic run, but browser shutdown stalled; do not label that run fully green. ESLint found no errors and two pre-existing unused-state warnings. No live database, employee, clinic data, staging or production was accessed.

End-to-end leave approval/cancellation with attendance and payroll remains untested in this review. Automatic payroll effects require an explicitly approved policy (day/hour basis, holidays, paid/unpaid leave, overtime and retroactive changes) and coordination with Claude. Do not infer policy from old stored settings.
