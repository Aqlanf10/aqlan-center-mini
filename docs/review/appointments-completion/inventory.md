# Appointment continuation inventory — 2026-11-03

## Verified baselines

- `main`: `6a6bdc0cc705874fd4ff6d0f0ddc3fdcd314e9e6`.
- Live Railway `staging-web`: successful deployment `694da910-f37c-49a1-b201-285b6f5e880e`, created 2026-11-03 14:38:44Z, source `cebe62f2e8d3d20a1196e10e9da892a30ec235cb` (`fix/runtime-verifier-performance-20261103`). Read from the deployment API; no Staging HTTP or data mutation performed. Source is 70 commits / 276 changed paths ahead of main.
- Previous Stage source `1b5f3c61df702be1d5283d295a3e1b420196c94b` is removed, not the current live deployment.
- PR514 remains open/draft/unmerged: `ae45de92bf6b835fce0f7509aa5f1f8605f97769`. Main-based PR includes inherited stack (171 paths), though its final appointment-specific commit is a narrow confirmation projection. CI41359923518 successful.
- PR515 remains open/draft/unmerged: `b785d75f320a8c8e948f244cccd05998b611a350`, based on514. Its final commit changes32 files, entire main-based PR200 files. CI41370142094 failed. Live Stage and515 share ancestor1b5f3c61;515 has2 exclusive commits, Stage37. Neither appointment commit is live by this ancestry check.
- Continuation: isolated worktree `/workspace/appointments-astra`, branch `feat/appointments-completion-astra-20261103`, starts at515. Draft review should use515 as base and disclose eventual integration separately.

## CI515 failure evidence

Typecheck job125038653221: `__tests__/postgres/appointment-purpose-provenance.test.ts`114–139 uses PoolClient where runtime returns DbClient, with nullable writer errors; `lib/book-direct-purpose.ts`212–213 accesses outsideHours/state/message on never. Later lint/unit/audit/build stages were skipped; missing audit artifact is secondary.

PostgreSQL job125038653408:3610 tests passed,12 failed,11 skipped;10 failing files. Failures include stale migration-chain expectations after0095 in debt-installments-storage, hr-runtime-registration, legacy-doctor-fk-compatibility, patient-appointment-history-index, prescription-lineage-restore and prescription-migration-lineage; hr-composed-backup and periodontal-restore setup failures; schema-fingerprint and schema-ownership fixtures/contracts outdated. Current schema differs by new purpose table, indexes, constraints and triggers. Regenerate from verified native PostgreSQL18 output, do not hand-fabricate hashes or suppress drift.

CI links:
- https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/41359923518
- https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/41370142094

## Parallel work boundaries

- WORK506 `45c3ffee5c988845f43acfd3a6f4c52fe6336f26`; Opus517 `1e4f83d6720557f10f2d13568b02a07a84648ba4`.
- Ortho513 `73e72a4e6c00a3ed2fd24692e0b6e08e517e93ff`; newer `feat/ortho-integrated-20261103` `10c06b34389e52314f4ac64c9e92c2aaa4930953` plus separate assessment/intake/workup/facial/records/navigation branches.
- Rx519 `1414a3514df3e01f0513dfc00b4358d482d862ef`; Rx520 `7baeff369f775dbe6999f4e80734369097bb6006`.
- Radiology521 `4558361570c9db356c45cb447901f7bdb86d2d31`, reserves0094; Rx stack owns0093. Appointment515 advertises0095. Leave published migration bytes unchanged; any separate new category schema uses a separately checked next reservation.
- No other branch was merged into continuation. No verifiable standalone Gemini appointment patch located in inspected history; do not claim it reviewed or copy unknown work.

## Prior local candidate access

Library resolved `libfile_e22c6d7f4b84819188139c2fa534d459`, version2, filename `NEW-appointment-direct-recovery-candidate-20261103.zip`,135383 bytes. Supported Library materialization helper failed to download in normal and escalated execution. Independent hostname connectivity check reports proxy403 Forbidden. No local file was produced or inspected, and claimed67-test prior evidence is not reverified in this environment. Do not imply its bytes are included.

## Functional findings requiring completion

- Existing515 purpose codes describe visit intent (consultation/start_treatment/continue_session/try_in/delivery/follow_up), not clinical treatment categories. Preserve that distinction when adding owner's requested ortho/new-ortho/endo/filling/prosthetics/awaiting-prosthetics lists.
- Existing booking writer already provides day advisory locks, capacity/overlap/provider-block checks; existing doctor roster resolver handles explicit identities, split shifts and approved leaves, but current roster API is advisory only. Admission must use consistent transactional evidence, including concurrent leave/schedule edits.
- Existing reminder text formats stored civil scheduledTime directly; do not assert an hour-offset fix without reproduction. Browser timezone/date and reminder route boundaries require synthetic verification.
- Existing center defaults09–21 have no second shift; preserve saved configuration if adding requested09–13 and15–19 defaults/presets.

## Isolated testing infrastructure

Local Docker container `aqlan-appointments-pg18-20261103`, PostgreSQL18.6, new synthetic database only, bound127.0.0.1:55432. Node22.23.3 available at `/workspace/.cloud-tools/node_modules/node/bin/node`. Runtime default Node24 is not repository target. No live DB credentials or patient data used.

No merge or deployment is authorized by this continuation. Staging acceptance remains separate after source/CI review.
