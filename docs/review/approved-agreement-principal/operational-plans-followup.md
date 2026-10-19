# Operational plans journey: explicit covered-work identity

Baseline: `9fe4f2276c43ee9821e6eb217fee8f93c238dcb2`, PR346. Hosted runs39178658648 and39178662734 failed at Operational verification journeys after PostgreSQL and schema verification passed. Root's CI tracker identified `plans` as the sole failed journey (19/20 passed). Local `npm run verify:plans` independently reproduced the same seven failed assertions on the exact baseline before editing.

## Actual cause and narrow repair

The journey schedules installments, adds a matching procedure without `planItemId`, then expects implicit matching to complete a covered item. FIN008 correctly refuses that unlinked financial identity, so the old positive fixture never reaches signing. The missing old warning substring is downstream of the new conflict warning, not evidence that the guard silently allowed billing.

Only `scripts/verify-plans.mjs` changes behavior in this follow-up. It first keeps the unlinked procedure and asserts a named conflict plus unchanged persisted clinical/financial state. Then it explicitly supplies the consented filling item's ID and runs every original positive assertion unchanged: one matched item, installment warning, successful sign, one completed item linked to the visit, unchanged other item and25000/145000 clinical progress. It additionally asserts zero new invoice/debt for that included session. The original second-visit count check remains, with added explicit refusal and unchanged-state assertions after the covered item is completed.

The snapshots include visits, procedure rows, plans, items, sessions, invoices, payments and the patient chart. No acceptance assertion, timeout, skip, production guard, permission or financial amount was weakened. There are no `lib/db.ts` or other production changes, so this follow-up does not overlap stacked PR348's reader/UI work. No merge, deployment or live data access occurred.

## Verification

Commands use the disposable PostgreSQL18.6 localhost service, synthetic session secret and clinic timezone Asia/Aden. Every operational journey creates and destroys its own isolated database.

```sh
npm run verify:plans
npm run verify:ci
npm test -- __tests__/verify-ci-orchestrator.test.ts __tests__/verification-entry-safety.test.ts __tests__/environment-parity.test.ts __tests__/multi-session-conflicts.test.ts
npm run build
npm run typecheck
npm run lint
git diff --check
```

The targeted journey failed before and passed after the fixture repair. Related unit checks:313 passed/1 existing skipped. Fresh build passed with database connection variables removed. Lint:0 errors/208 repository warnings. The complete operational gate passed20/20 journeys with no failures or skips; typecheck also passed. Full raw red/green and verification logs are preserved losslessly in `operational-evidence/`, with SHA-256 manifests. This is a test-fixture correction, not a new production fix; the unchanged production code already passed hosted full PostgreSQL/schema gates. Full hosted CI and independent review remain mandatory before root may clear the merge hold. Other finance findings remain outside this change and are not claimed resolved.
