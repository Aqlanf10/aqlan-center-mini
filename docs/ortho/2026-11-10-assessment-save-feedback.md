# Assessment save feedback — 2026-11-10

The existing validator could refuse a partially recorded assessment with a generic message away from the save action. The editor now lists the specific missing field and section beside Save, marks the revision reason as required, and explains conflicting source versions or the reference limit. Untouched observations remain unrecorded; validation, authority and mutation ownership are unchanged.

The same draft survives refusal, navigation and correction. The feedback updates when the clinician supplies the missing information. The actual browser workflow saves one revision even when the first committed response is lost and the same request is retried. No invoice, visit, retention record or study is created by that workflow.

Evidence:

- Component/owner/editor checks: 26/26 passed. Full TypeScript passed; scoped lint has zero errors and one existing hook warning.
- Before change: the new 390px browser assertion failed because specific save feedback was absent on the built `4a53c858` application.
- After change: production build on `84b22877` passed; the full workflow passed at 390px and 1280px against isolated PostgreSQL 18.6 using synthetic patients and Chromium 151. The two cases cover invalid input without a POST, preserved draft, correction, lost-response recovery, section navigation and reload.
- Hosted CI for this new checkpoint is still required. The preceding `4a53c858` print job passed 50/50 with bundled Chromium 153; that result is not evidence for subsequent commits.

This is a focused usability improvement, not acceptance of the entire orthodontic unit. Evidence logs are retained outside the repository under `/workspace/ortho-resume-evidence/daily-ux-work/`.
