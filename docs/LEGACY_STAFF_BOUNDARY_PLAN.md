# Legacy staff boundary — local implementation, not rollout

Frozen base: `bcbc8819eca0802ea5c4598b5b4ea78a012b8194`.
Separate branch/worktree: `local/rebuild-legacy-boundary-20261027` / `rebuild-legacy-boundary-20261027`.

## Current gaps

- `findUserByUsername` maps raw permissions through the permissive legacy mapper without classifying account authority. Login and `requireSession` therefore still accept marker-free old tokens/password logins for converted accounts.
- Password renewal reuses those same legacy paths.
- Backup read-only authorization and HR identity preview have separate fresh account readers and must not be overlooked.
- Legacy `updateUser` and `linkUserDoctor` can target a canonical account. `createStaffUser` currently creates a doctor party outside its commission transaction, so a later refusal can leave side effects.
- `createFirstAdmin` is another legacy issuance/provisioning boundary; no authority-schema state may fall through into it.

## Conservative proposed policy

Permit legacy staff operations only on positively observed ordinary base schema with no authority markers. Any authority-schema footprint (known v1/v2, partial/corrupt state, obsolete v10 identity tables/column, guard functions/triggers) holds legacy access closed globally. This slice does not support mixed canonical/legacy authority realms or infer that a row saying `legacy` overrides a canonical target state.

Additionally, canonical or invalid raw permission envelopes are denied before legacy mapping even when no schema markers exist. The classifier must distinguish true absence from unreadable/missing/forged relations or partial markers, not catch query errors as absence.

Root and reviewer approved this global hold only as an explicit unactivated maintenance/cutover contract. Merely installing any authority marker halts legacy access, so this must never be described as live-compatible gradual rollout. No authority schema is registered or installed, so unchanged ordinary base behavior remains the compatibility target. Installing any future authority schema requires the complete canonical entry path beforehand; this proposal is not an activation path.

## Proposed implementation boundary

- New `lib/legacy-staff-boundary.ts`: read-only catalog/account classifier, no ensureSchema, DDL, repair, migration, grants or credential issuance.
- `lib/db.ts` restricted to lookup and four staff writer seams: `findUserByUsername`, `createFirstAdmin`, `createStaffUser`, `updateUser`, `linkUserDoctor`.
- Independent readers: `lib/backupReadOnly.ts` and HR identity authorization seam in `lib/hr-identity-sources.ts`; preserve their read-only snapshot contracts.
- `lib/session.ts` only where needed to keep selected signed-source precedence/refusal and fresh account checks coherent.
- Unique boundary tests and targeted existing login/password/commission regressions. No UI, proxy redesign or broad finance/clinical modifications.

The schema classifier runs before ensureSchema on recognized authority footprints; it must never allow implicit repair to turn partial state into a legacy-compatible state. Writers then acquire the same shared central lifecycle fence and classify schema plus target under their transaction before mutation or commission baseline writes. Future schema installation/conversion must take the matching exclusive fence. A read-only classification is not an enduring authorization capability.

Move doctor-party creation into the existing create-user commission transaction after the boundary guard. For update/link, run the guard as the first transaction callback step, before target/party writes or commission-history work. Reject non-legacy input permission envelopes before mutation. Preserve transaction/audit/commission behavior for ordinary legacy accounts.

## Required tests

- Real unchanged base: normal login/session/password renewal and staff create/update/link remain functional.
- Canonical raw envelope with no schema: no legacy mapping/issuance/session or target mutation.
- V1/v2/quarantined/ready/partial/old-v10 footprints: fail closed; no DDL/repair and no owner fallback.
- Marker-free previously valid signed token for converted account is refused by general session, backup read-only and HR preview.
- Denied staff mutation leaves user, party, commission history and audit unchanged; creation cannot leak a doctor party.
- Actual concurrent lifecycle fence contention followed by fresh classification; no stale preflight result becomes operation authority.
- Preserve cookie/Bearer source semantics and shared strict signature checks; do not allow a canonical cookie to become legacy Bearer authorization accidentally.

## Remaining blockers after this slice

No canonical login/session/UI routes, owner preparation/trust, ready-state reset/recovery, source authority import, or inventory activation is implemented. Classification and legacy refusal do not themselves authorize the new runtime.


## Exact marker inventory

Use exact names, never a broad `staff_*` prefix or unrelated HR objects:

- Relations: `staff_authority_control`, `staff_identity_generations`, `staff_identity_subjects`, `staff_identity_state`, `staff_identity_binding_events`, `staff_identity_current`, `staff_authority_identity`, `staff_execution_epochs`.
- Columns: users.`authorization_mode`, `authorization_epoch`, `staff_subject_id`; parties.`clinical_authority_epoch`.
- Functions: `staff_authority_control_guard`, `staff_account_authority_epoch_guard`, `staff_clinical_authority_epoch_guard`; `staff_identity_history_guard`, `staff_identity_state_guard`, `staff_identity_subject_guard`, `staff_identity_event_guard`, `staff_identity_current_guard`; old `staff_subject_identity_immutable`, `staff_realm_identity_immutable`, `staff_execution_epoch_immutable`.
- Exact corresponding 16 frozen/substrate triggers, plus old `users_subject_identity_immutable`, `staff_realm_identity_immutable`, `staff_execution_epoch_immutable`; old index `users_staff_subject_identity`.

Orphan functions/triggers/indexes count as partial authority footprints. Query failures, unexpected duplicate catalogue results, foreign relation kinds or unreadable sources are refusal, not absence.

## Approved original actor-proof integration

The existing staff-writer context contains only a username audit label, not a verified session. Guarding only a target cannot prevent an acting legacy account from being converted/revoked after request-level admission. A complete writer slice must carry the original signed session proof, bind it to the actual transaction, and classify both actor and target under deterministic row-lock ordering. It must never reconstruct authentication from `ctx.actor` or permit a missing-proof fallback.

Actual production callers are users POST/PATCH and self-password renewal. A narrow original-proof contract can require additional ownership of those routes and auth/session private proof plumbing; first-admin setup remains separately restricted to empty base/zero accounts. The approved implementation carries an opaque private original signed-session proof, repeats actor/target checks after waits under sorted locks, and has no missing-proof/SYSTEM-label fallback. Normal intended self-password changes need an explicit operation-specific renewal contract rather than blindly revalidating the old credential after its authorized replacement.


## Implemented transaction and read boundaries

Staff writer preflight occurs before ensureSchema; the actual write transaction repeats the shared central fence, exact marker and raw actor/target checks. Doctor-party creation moved inside the existing commission transaction. An optional final hook runs after commission history work immediately before commit; default behavior for all other callers is unchanged. Commission audit remains after commit as before; a final refusal prevents it from running. Intended self-password changes use a tightly restricted self-only payload and expire the old credential without treating the authorized change itself as a foreign revocation.

Backup authorization uses READ COMMITTED READ ONLY and a shared transaction fence. HR preview retains its RR READ ONLY snapshot, but takes a shared session fence before BEGIN so a waiting installer cannot leave it with a pre-wait snapshot. Cleanup commits/rolls back, unlocks, then releases; uncertain rollback/unlock destroys the backend via supported release(true).

The preliminary catalogue check/transaction ends before `ensureSchema` in lookup, first-admin, and staff writers. No lifecycle fence spans that initialization gap: a concurrent installer can add a marker after preflight and before initialization. This slice does not guarantee absence of DDL in that race; mandatory maintenance quiescence/draining and the installer exclusive fence are prerequisites, not optional live-cutover advice. `linkUserDoctor` now additionally locks old/new parties in sorted order after actor/user locks and revalidates the intended active doctor before any commission baseline or link mutation; preliminary validation is not the mutation authority.

These are fresh admission boundaries, not a global request-lifetime conversion protocol. Unadapted nonstaff legacy handlers may authenticate and later work after lookup locks release. Before any future installation/cutover, operations must be quiesced/drained and the installer must take the matching exclusive central fence. Merely adding markers is deliberately disruptive and is not a live rollout plan.

## Current focused evidence (not full acceptance)

Combined seven-suite real PostgreSQL verification passed 55 tests: classifier/actor-target fences, actual application writers, HR snapshot/converted-admin refusal, real login/session/password routes, backup endpoint read-only authorization and existing HR identity readers. A subsequent writer rerun passed 8 tests, adding observed concurrent doctor disable/kind-change refusal before link/commission/audit effects. These are isolated fixture-owned databases or uniquely prefixed schemas; cleanup verifies ownership and closes the exact app pool first.

54 focused auth/session tests, 6 injected cleanup tests and 107 existing reader/session units passed. Scoped TypeScript checking passed; focused lint had zero errors (existing db.ts unused warnings only). Evidence: `recovery-evidence-20261027/legacy-boundary-final-pg.log`, `legacy-doctor-link-race-pg.log`, `legacy-session-boundary-pg.log`, `legacy-boundary-types-final.log`, and `legacy-boundary-lint-final.log`.

Independent source review is required before checkpoint acceptance. Six older financial PG fixtures still require genuine signed synthetic administrator evidence instead of audit-label-only calls; no missing-proof compatibility bypass is provided. Full-suite/CI acceptance and all canonical activation blockers remain outstanding.

## Invoice revision preview compatibility (bounded follow-up)

`readInvoiceRevision` now uses a named SELECT-only legacy snapshot lookup and session revalidation, not mutation admission before BEGIN. The wrapper checks the original schema before initialization, acquires the shared session lifecycle fence before its RR READ ONLY snapshot, then repeats exact schema/raw-envelope and credential/role/permission checks inside that snapshot. Financial calculations are unchanged; mutation `reviseInvoice` keeps transaction-bound locked authorization. The named read helper checks READ ONLY and REPEATABLE READ and is not an operation capability. Only genuine session derivations carry signed-origin evidence.

As with the other legacy initialization seams, the preflight-to-ensureSchema gap is not fenced: installation requires maintenance quiescence/drain. Snapshot data reads never initialize schema, allocate sequences, lock rows or write data. Completion checks expiry, commits/rolls back, explicitly unlocks and discards a backend after uncertain acquisition/rollback/unlock. This change is not canonical login or activation.
