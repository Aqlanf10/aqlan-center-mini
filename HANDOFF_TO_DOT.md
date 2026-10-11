# Current integration status — PR #308, 2026-10-11

This section supersedes the historical delivery status below. The branch remains `feat/hr-staff-tasks-phase1`; the literal current published head and its exact-head CI links are maintained in [PR #308](https://github.com/Aqlanf10/aqlan-center-mini/pull/308). Source review alone does not establish merge or deployment readiness.

## Verified ancestry and evidence

- Ordinary integration commit `f180a6db990a956e62e5c15abc6f46335066f928` has ordered parents `78d484590895fd73209021383700b8a142f17238` and main `148fcbeac229cb279848e6ea37049d1599a4fafe`; its tree is `d8f7bc94818cc185122e65c63e192e816d0778fa`. Main's native-control clinical visit workspace test and independent HR changes were preserved. [Integration CI 38104085125](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38104085125) completed successfully. This is the pre-P1-repair combined baseline.
- P1 repair commit `1dd5dd9f67bdadcf32f5161b3983373d2d18d8c7`, tree `5685ec4ae119de7dd1798effd93046c91b6550f0`, was published on that integration. [PR CI 38105815224](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38105815224) and [push CI 38105812642](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38105812642) failed Typecheck: TS2305, missing `revalidateSessionInTransaction` export in `lib/session.ts`. Subsequent lint, unit, PostgreSQL, build and HTTP gates were skipped. Artifact upload errors are secondary. No new runtime success is claimed from those runs.
- This successor adds the missing canonical session wrapper and the mounted-owner task read boundary with focused regression tests. These source changes were independently reviewed before publication. Their execution result must be read from the current exact-head CI linked in the PR; at source preparation they have not run. Earlier green results cannot prove this successor.

## Current source repairs

- Task creation replay is bound to the original actor, current read authority and canonical original request. Foreign keys or changed payloads fail without exposing private task content. Per-key locking, current session and assignee checks after waits, and atomic task/event/audit writes keep replay and creation in one transaction.
- The task form preserves its original key and immutable body through uncertain replies and modal close/reopen. Only a matching first-attempt no-write refusal unlocks editing; an earlier ambiguous operation stays protected. Receipt admission requires the expected owner and request key. Private pending data is held only in mounted parent memory. Reload/full navigation recovery is not claimed; the warning and before-unload guard tell the user to review existing tasks before starting another request.
- The successor keys list/detail state to the current owner and admits responses only for the current request generation. Same-role owner changes synchronously retire the old private view; delayed list/detail or creation responses cannot restore a retired owner's content or clear a newer form. Four real-React mounted browser cases exercise synthetic transport without a reload-only shortcut. They complement the signed HTTP and PostgreSQL task tests, rather than replacing them.
- Contract lifecycle repair enforces draft completion and allowed transitions, preserves approved terms, revalidates the admitted session within transactions, and allocates unique contract/addendum identifiers under the intended locking. Contract API, UI, print and fixtures were updated together. The successor session helper delegates to the existing canonical current-account checks; it does not authenticate arbitrary client objects.

## Required before acceptance

The final exact-head Typecheck, lint, unit, PostgreSQL, schema, audit, build and HTTP gates must pass, including task replay, mounted owner privacy, contract lifecycle/concurrent addenda, payroll and attendance coverage. Any remaining substantive review finding must be resolved. The historical schema/policy limitations below remain disclosed unless current evidence explicitly resolves them. Combined Staging compatibility and native evidence review remain outstanding; no current Production verification or deployment is claimed. Main merge and deployment have not been approved by this handoff.

No CI timeout, permission matrix, financial assertion or migration gate was relaxed. The successor uses the already locked esbuild 0.28.2 dependency; no dependency installation or local application/test/build/SQL execution formed this source review.

---

# Historical HR delivery record retained verbatim

The following record describes earlier delivered source and earlier test/deployment states. Its uses of “current” or “final” belong to that historical work, not the successor above.

# Integrated HR repair handoff — PR #308

## Current follow-up: verified payouts, reversal recovery and transaction authority

Final compatibility review additionally fixes confirmation of a legitimate original keyless payout's reversal. Its original `null` key is preserved exactly, with no invented key; new payouts retain mandatory stable keys. Real browser cases at both widths failed on `2112b61f` despite a committed 200 reversal, then passed with one reversal voucher, unchanged database key and zero net cash. This client-reader correction adds no schema/backend/financial-policy change. See the final compatibility section in the current evidence packet and the literal final head/CI links in PR #308.

The current work starts at `cfa1dda16da25ebdd5530bfd881578455428d808`, verified against PR #308 before edits. It continues on `feat/hr-staff-tasks-phase1`. The final head and completed exact-head CI links are recorded in PR #308. This follow-up adds no migration and does not change the financial policies, financial engines, CI rules or test deadlines.

- The UI verifies the actual payout identity, employee, item, request key, native currency, amount and salary/commission voucher components before marking a stored operation completed. An HTTP success with a missing or unrelated receipt keeps the original immutable request. Explicit verification uses the same key; an unrelated lookup response cannot clear the pending operation. Retrying a committed request returns its existing receipt without another expense.
- A reversal request saves the exact original disbursement ID and reason before sending. An uncertain response preserves that request across reload, blocks a new payout, and offers verification of the same reversal. Only a complete matching receipt clears it. Verification/replay produces one reversal voucher and a zero net cash effect for the original expense.
- Every payroll HTTP writer revalidates the signed session and current active account, role and credential version inside its transaction, with the account held `FOR SHARE` through COMMIT. The session is checked again after domain lock waits. Revocation while a request waits cannot create a payout; expiry before completion rolls back all financial writes. Uncertain COMMIT recovery rechecks authority before returning a receipt.
- A multi-policy settings patch now runs in one audited manager-only transaction. Failure auditing its second policy rolls back the first policy as well. Unexpected database errors are not returned as raw exception messages.
- An older payroll fetch cannot replace the newly selected period/currency or resurrect rows after loading fails. Selection immediately hides the old run and disables its actions; responses are checked against a request generation and current selection. Two real-browser delayed-response cases prove the old behavior failed at both widths.

Current executable evidence, synthetic screenshots and a source-only integration/migration comparison are in [docs/evidence/hr-payroll-confirmation/](docs/evidence/hr-payroll-confirmation/). Local and CI results must be read with the limitations below; a passing HR branch is not proof of a deployed combined staging version.

## Financial integration retained and checked

`__tests__/postgres/hr-payroll-integrity.test.ts` uses real independent PostgreSQL cases and canonical readers/writers. It proves intentional contract/profile disagreement blocks approval without creating debt; approved wage snapshots survive later contract addenda; profile fallback records its actual source; unsupported mid-period/nonmonthly calculations remain blocked. Currency cases use YER, SAR and USD minor units without aggregating their balances.

Hybrid settlement creates separate `salary` and `commission` expenses tied to their respective payables and one HR operation. Tests verify the derived payable remainder via `partyStatement`, canonical doctor commission paid/due values via `commissionReport`, real expenses and shift cash totals. Partial allocations, another commission payment engine, reversal, failed audit, concurrent same-key requests, different-key overpayment, closed periods and lost COMMIT responses are checked against those financial sources. No `payables.balance_minor` was introduced and no new commission engine was created.

`__tests__/postgres/hr-backup-roundtrip.test.ts` restores nondefault leave-type/settings IDs, entitlements, relationships, raw attendance events/corrections and subsequent sequence allocation, and independently restores a pre-HR backup. Settings stored in a backup are preserved, not replaced by invented defaults.

The browser journey covers salary, percentage and hybrid employees, separate vouchers, partial payout/reversal, printed payroll rows and next-day correction approval by a second synthetic manager at both 390 and 1280. The role matrix and doctor/reception restrictions remain mandatory.

## Previous attendance repair and evidence retained

The previous attendance follow-up started from the remote/reviewed head `2763bc6018dd253e604bd1b7240f1a7206662a4f`. The existing checkout was clean and GitHub reported that exact head before edits. Work remains on `feat/hr-staff-tasks-phase1`; no duplicate branch, force push, main merge or external deployment is part of this follow-up. The final literal repair SHA and exact-head CI links will be recorded in PR #308. Application source used for that previous proof was frozen at `07f39992563255ecb329731837f0ee109d35a784`; its later delivery edits were evidence/report only. This is an earlier build reference, not a verified Production deployment. Existing integrated main ancestry is `f1164bbecc0bbf9f4a12855aa54827c3d8b44a60`; this follow-up does not add a main merge.

## Repairs

- Attendance correction inputs have independent, labelled clinic-local dates and times. Existing next-day timestamps initialize their actual date; a missing timestamp remains empty. The UI does not infer tomorrow from clock ordering. Review cards show dates as well as times.
- A repeated exact punch is associated with the record containing its original punch event before considering a current-day row. Legacy completed night records without event rows also match their exact stored raw checkout. The completed August 1 night shift therefore retains an August 2 06:00 replay, and August 2 22:00 starts its own record.
- The private attendance upsert takes effective timestamps separately from the incoming raw punch. Only that punch's side can fill a previously empty raw field. Approved values remain effective when later real evidence arrives; its distinct original timestamp is preserved in raw and the event log. Neither direction synthesizes an opposite-side punch. A completed effective night projection with no raw exit can accept its later physical exit on the original shift. Exact evidence wins association; a current shift takes precedence only when its known entry is at or before the incoming instant. Clock ordering alone does not infer a correction date.
- Leave cancellation removes only placeholders without evidence/history, then clears `on_leave` on retained records based on their effective timestamps. Corrections, raw timestamps and events are retained. The existing staff lock, transaction and already-decided check keep double cancellation from returning balance twice. On the first actual punch, a retained placeholder obtains its governing schedule if none was recorded; the next-day checkout can then complete its night shift.
- Reception's UI no longer offers the admin-only correction action. Strict route role restrictions, doctor tab restrictions and the unchanged HTTP permission matrix remain enforced. Self-approval is checked before an already-approved decision can replay.

Existing schema contracts/disclosures remain unchanged, including the 16 predeclared convergence findings and `applicationSchemaEqual=false`. These are not claimed resolved. Dot must regenerate/verify combined schema contracts through the official path rather than merging fingerprints by hand.

Existing contract-derived wage snapshots, YER/SAR/USD minor-unit handling, commission engine linkage, separate hybrid vouchers, atomic HR settlement, durable request-key replay and audited reversal guards are retained; the current follow-up adds transaction authority checks and verified UI confirmation. No payroll migration, permission matrix, timeout or CI rule was relaxed. Unsupported proration/nonmonthly pay, missing paid-leave allocations, commission-policy conflicts and legacy claims without reliable snapshots/component linkage remain explicit owner-policy blockers.

## Executable evidence

The same final PostgreSQL workforce test file was copied onto a separate `git archive` of the exact baseline, using the existing dependencies and real writers on owned PostgreSQL 18.6 fixture databases. No branch or worktree was created and the working repair source was not replaced.

- Baseline `2763bc60`: **10 failed / 12 passed**, with the identical final 22-case test file. Failures cover the actual night/raw/cancellation regressions and self-approval replay; the remaining original invariants continue to pass.
- Repaired source: **22 passed**. Assertions also cover a subsequent distinct real punch, unchanged approved actual time, no invented opposite event, double leave cancellation, retained correction decision and valid post-cancellation punch.
- Old built production source, attendance component byte-equal to baseline: both 390 and 1280 browser regressions failed because independent date fields were absent. The old build ID was `W_ohN31kKNHkCt6YInZKu`.

Commands:

```sh
source /workspace/.aqlan-env/development.sh
npm run test:postgres -- __tests__/postgres/hr-workforce-integrity.test.ts
HR_EVIDENCE_DIR=/tmp/hr-followup-evidence npm run test:security-http -- __tests__/security-http/hr-payroll-journey.test.ts __tests__/security-http/hr-ui-journey.test.ts __tests__/security-http/http-permission-matrix.test.ts
npm run typecheck
npm run build
```

Baseline and green logs are retained under `/tmp/hr-followup-{red-clean22,green-clean22,browser-red,browser-frozen24}.log`; the durable copies and synthetic screenshots are linked in `docs/evidence/hr-attendance-followup/README.md`. Typecheck and the frozen-source production build passed. Immutable preflight assets (48) and runtime provenance (6516 files / 321 traces, build `DINKQBbU70AFFLojaWfM0`) also passed. Targeted lint has zero errors and one pre-existing unused-type warning. A repeat PostgreSQL setup attempted during the frozen build hit its unchanged 30-second hook deadline (113.63 seconds in transformation; 22 cases unexecuted), and a second checkout run also timed out during module transformation. A clean `git archive` of the frozen `07f39992` source, with identical dependencies/configuration and no generated build tree, passed all 22 cases with the same 30-second hook limit. No test/setup step or deadline was moved or relaxed. Exact final CI links/status are recorded in PR #308 after completed runs, never inferred from the old successful CI on `2763bc60`. The full 24-case local browser/security journey passed again on the frozen-source production build, including actual second-admin approval, final attendance display, raw/event/decision checks, real authenticated reception/doctor pages and browser employee spoofing attempts at both widths. One existing private-task journey used an arbitrary 800ms sleep; it now awaits the real task POST (201) and the unchanged visible-text assertion instead, keeping its previous overall deadline and all privacy checks. The new role-tab assertion was corrected to include the accessible name’s decorative icon rather than requiring an impossible bare exact name. The initial new browser journey blocked waiting for Playwright response JSON: creation committed and returned 201, but the client never consumed its success body and no finished-response event arrived. A separate real-browser reproduction observed 201 and a body wait exceeding 10 seconds. The UI now reads and validates creation and decision replies before reporting completion; the test retains its response-body and durable-result assertions. No existing timeout increased; the new cases use the unchanged global 120-second limit.

## Migration inventory and proposed staging composition

The repair adds **no migration**. Read-only source comparison against user-confirmed ceph reference `eadd75028cbf35188d972a7521022522538c31d6` finds ceph-only `0047_ceph_correction_lineage.sql`, the five HR-only files below, and zero differences in common migration contents. Latest fetched main `148fcbea` also has no conflicting common migration contents. This compares source files, not the external applied ledger. HR source inventory is `0045_hr_staff.sql`, `0046_hr_tasks.sql`, `0048_hr_contracts_attendance_leaves.sql`, `0049_hr_payroll_disbursements.sql`, `0050_hr_payroll_integrity.sql`. Every file is byte-equal to the reviewed `2763bc60`; 0045/0046/0048/0049 also remain byte-equal to the originally received `e5c4e4ae`. Dot's reservation of 0050 remains source-number approval only.

Before changing the service, dot must provide/confirm the currently deployed staging SHA and exact ceph integration source. Several ceph branches exist; no branch name was assumed to be deployed. The following plan is for review, not an executed deployment:

1. In the actual deployment platform, verify project ID, service `staging-web`, environment `staging`, current source/ref and deployed SHA; obtain the staging URL and migration ledger plus checksums from the staging database only.
2. Preserve the current ceph/staging source. Compose the HR repair into dot's agreed integration point, preserving both sides' migrations. Compare duplicate numbers, file contents and applied ledger; stop for a conflicting number and ask its owner to reserve a number. Never renumber or edit an applied migration, reset a database or replace the service with plain HR/main.
3. Review and run the full mandatory CI on that exact combined SHA, including PostgreSQL, schema ownership, security and browser journeys. HR-head green CI alone does not qualify the combined source.
4. Dot remains the sole publisher and deploys the agreed combined SHA to `staging-web` in `staging` after review and green combined-version CI. This task does not transfer that responsibility. Verify the deployed SHA and actual screens; repeat night correction/replay, raw separation and double leave cancellation, plus salary, percentage and hybrid cases with synthetic data and no real payments/messages.

Staging handoff: the user supplied https://staging-web-staging-0d39.up.railway.app, service `staging-web`, environment `staging`, and last verified deployed reference `eadd750` from ceph. Dot is updating it with main while preserving 0047. **Publishing remains dot's responsibility; it has not been transferred.** There is no direct cross-session channel: this report is delivered to the user for forwarding to dot. No staging source, database, service or permanent account was changed.

A read-only public health request was blocked by the environment's outbound proxy (403 tunnel rejection). No Railway CLI/connector or deployment credential binding is available. Current deployed SHA, applied migration ledger and live screens therefore remain independently unverified; `eadd750` is the user's last verified reference, not a newly observed deployment. No combined-version CI or post-deployment scenario is claimed. Dot must compose, review, test and publish the compatible source before shared staging acceptance. Production is not a fallback and this PR has no merge authorization.
