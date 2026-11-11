> Historical preservation note (2026-11-11): recovered from Staging commit `779bf35`. This document records its original review context, not current deployment state or authorization. Branches, migration prerequisites and commands below must be revalidated against the selected candidate and target before use.

# Central clinic owner binding — design awaiting review

Status: binding schema and authority remain a proposal. The actual WORK SELECT-only detector and a non-applicable read-only candidate inspection tool are extracted; neither is wired into login or grants authority. No schema, provisioning command, owner identity or live grant is implemented. The Rx owner adapter still returns null. Ordinary clinician issuance and reception reprinting remain independently usable under their existing checks.

## Evidence and allocation

Allocation update, 2026-10-31: migration 0092 is now allocated to the Rx prescribing-doctor name snapshot; it is unavailable to this owner-binding proposal. The earlier 0bc3a0c5 comparison inspected an intake branch, not the current WORK branch. The subsequent coordinated read-only checks used WORK 34b0d619a671f5b414fa0ccfea8d0489bf1721e5, #490 7377434dea25cd52ae2540c7e56ec8363a31a5de, and main 6a6bdc0cc705874fd4ff6d0f0ddc3fdcd314e9e6, none containing numbered 009x migrations. Any future owner-binding migration needs a separate allocation review; this proposal creates no schema.

WORK `lib/legacy-staff-schema.mjs` selects canonical mode on ANY enumerated authority table/function/trigger or `users.authorization_mode`, `users.authorization_epoch`, `users.staff_subject_id`, `parties.clinical_authority_epoch`. No such artifact, ready seal, login marker or canonical permission document may be created by this proposal. Its `readStaffEntryMode` is SELECT-only and fails on unreadable state; selection is deployment-wide, not a fallback per failed request.

Update against reviewed Rx507 (`258f0b9e`): the actual issuance path now reserves durable command0093, saves the immutable prescription snapshot and inserts the audit row on one client/transaction. Replay revalidates fresh authority and does not create another prescription or audit. This atomicity prerequisite is solved; the old non-transaction caller is not the API issuance path. Protected owner admission remains a separate unresolved prerequisite: the read-only owner adapter and mocked opaque resolver tests are not a functioning owner feature.

## Proposed files and schema (names subject to review)

- `lib/clinic-owner-authority.ts`: shared operation boundary and opaque owner handle; no Rx-specific identity or environment flag. It accepts a verified request session, never user-supplied owner claims or serialized `ResolvedStaffAccess`.
- `lib/clinic-owner-binding-schema.ts` and one reserved numbered migration: byte-identical DDL; three small shared relations, no canonical artifact names.
  - `clinic_owner_binding_state`: singleton current version, active/revoked state, explicit user and clinician IDs, captured identity revisions. Empty/unbound means no owner privilege. No account is chosen by migration.
  - `clinic_owner_binding_events`: append-only monotonically numbered binding/revocation history, previous/new IDs and revisions, operator/reason/time. State and history must agree; versions are bigint strings at JS boundaries.
  - `clinic_owner_identity_revisions`: monotonic revisions for user and doctor identities. Row triggers increment on changes to user role/active/doctor link and party kind/active state. These have new `clinic_owner_*` names and do not reuse canonical epoch columns. This catches A→B→A relinking, which checking only the current pair cannot detect. Revisions are not owner grants.
- `lib/clinic-owner-operation.ts` (or internal module): WeakMap-branded handle bound to client, transaction ID, session fingerprint, binding version and identity revisions; no transferable JSON authority.
- `lib/staff-owner-authority.ts`: one mode-selecting adapter to the shared operation boundary. Canonical-present means canonical runtime only (or refusal if unavailable). Legacy mode can use the explicit clinic binding; canonical rejection must never fall back.
- `lib/prescription-owner.ts` and `lib/db.ts`: use the operation callback and client-aware save; retain `doctorPartyId` issuer/void semantics, separate selected doctor snapshot, include binding version and actual actor in transactional audit.
- `scripts/clinic-owner-binding-plan.ts`: SELECT-only dry-run plan requiring explicit user/doctor IDs; no inference from username, role rank, first admin or environment ID. A future separately reviewed apply tool is not an ordinary admin API.
- Unit, isolated PG18 concurrency, HTTP and login-mode regression tests; schema/ownership/backup/reset manifests and migration-chain documentation updated after allocation.

## Authority and transaction contract

1. Validate signed session using fresh account credentials/active state/role. Require an active clinical provider; ordinary admin is not sufficient.
2. Select deployment authority mode using the trusted shared detector. Partial/unreadable canonical state refuses; no legacy fallback. No arbitrary feature flag chooses the mode.
3. Begin READ COMMITTED operation and acquire a shared clinic-owner binding fence. Binding administration uses the exclusive side. Lock current binding and account/provider identity witnesses in a documented fixed order; account/provider mutation triggers serialize changes through the identity revision rows.
4. After every awaited lock, re-read the session/account/provider/binding and compare the captured versions. A change while waiting rejects; it must not silently adopt a different binding. Revalidate expiration at the protected write boundary.
5. Validate selected registered doctor, patient scope and visit/patient equality inside the save transaction. Lock issuer and selected provider witnesses in stable ID order. Owner permission authorizes choosing the prescriber, not broader patient or void authority.
6. Insert prescription and mandatory audit on the same client/transaction. Audit includes actor user ID/name, issuer clinician, selected prescriber ID/name snapshot, binding version and proof fingerprint. Any audit failure rolls back the insert. Acknowledgement binding includes the same verified owner version; a stale version demands renewed review.
7. An opaque handle cannot be cloned, reused in another transaction, action, client or after commit. Display previews are projections only. No implementation may manufacture `ResolvedStaffAccess` from a user ID.

Before coding, reconcile lock ordering with `linkUserDoctor`, user role/active writers, party updates, clinical/patient locks and restore. Use revision-row serialization or a proved fixed order rather than adding opposite-order waits. Deadlock/refusal retries must not reuse an expired proof.

## Provisioning and migration plan

Dry-run prints a reviewable target identity (no credentials), explicit selected account/provider, current active/link state and revisions, authority mode, expected current binding version, proposed change and audit reason. It does not issue a session, modify accounts, choose an owner or create canonical markers. No apply is performed in this task without separate reviewed authorization naming the target and account.

If an apply implementation is approved later, it must require the exact reviewed plan/version and explicit operator authorization, hold the exclusive fence, revalidate all witnesses, append event/update singleton/write audit atomically, and reject stale plans. It is not exposed to every admin via `/api/users` or a generic setting. Permission edits cannot confer clinic ownership.

Canonical cutover is a separate coordinated operation: freeze binding changes, prove the exact account/provider against the canonical subject/realm and owner binding, carry lineage/version into the canonical audit, and retire legacy on-behalf admission before canonical activation. Canonical registry then becomes the sole source. A mismatch or partial canonical state holds issuance; no two-owner operation is permitted. Backup/restore must not silently reactivate a binding on another database; choose and test target-owned quarantine/rebind semantics before rollout.

## Required tests and risks

- Ordinary admin, unbound account, forged/cloned proof, inactive account/provider and invalid doctor all denied.
- Link A→B→A or disable/reactivate invalidates the captured revision; an explicit reviewed rebind is needed.
- Binding version changed during a lock wait rejects the stale operation/acknowledgement; no stale save.
- Audit failure rolls back both prescription and binding writes; actual actor and selected doctor remain distinct.
- Existing reception print grant never grants issuance or ownership.
- Binding schema/rows alone leave login in legacy mode; test against WORK's actual SELECT-only `readStaffEntryMode`, not a copied approximation. Existing login/session tests unchanged.
- Any canonical artifact selects canonical-only; unavailable/invalid runtime refuses without legacy fallback.
- PG18 lock ordering, concurrent relink/revoke, forged history, backup/restore quarantine and version monotonicity tested on synthetic databases.

The parent authorized extraction of WORK’s SELECT-only detector. `lib/legacy-staff-schema.mjs` is byte-identical to WORK 0bc3a0c5 except its import points to the separately extracted exact schema-name validator. A SHA-256 parity test fixes the original source identity; real PG tests exercise table, function, trigger and column footprints. No canonical DDL, initializer, admission runtime or login changes are imported. The candidate inspection tool performs SELECTs only with PostgreSQL read-only transactions enforced and always returns canApply=false.

Main review decisions: allocation of the migration number; acceptance of shared revision tracking; exact provisioning operator authorization; restore/quarantine contract; and the canonical runtime integration/cutover owner. These are unresolved design choices, not permission to provision a real owner.


## Reviewed lock ordering and actual writer compatibility

Required operation order: shared advisory binding fence (exclusive for bind/revoke), singleton binding state, actor account, all issuer/selected doctor rows sorted numerically, identity revision rows in the same entity order, then patient/visit witnesses. Read account and doctor rows with NOWAIT; any 55P03 ends the whole transaction with a retryable refusal. A retry starts fresh session and binding verification, never reuses a proof. Revision reads are also NOWAIT and require exactly one existing row; issuance must not create a missing witness. The fence does not replace row/revision verification after waits.

Actual base writers in `lib/db.ts` were inspected:

- `linkUserDoctor` takes the account row FOR UPDATE, then `withDoctorCommissionChange` takes old/new doctor rows in numeric order, then updates the account.
- `updateUser` with commission changes takes the account, then linked doctor; without commission changes its UPDATE acquires the account row directly.
- `updateParty` with commission changes takes the doctor row first; otherwise its UPDATE acquires that row directly. It does not acquire an account afterward.

Revision triggers must only increment the witness belonging to the row being changed. They must never acquire the binding fence, another account, or another doctor. This preserves account-before-own-revision and doctor-before-own-revision; issuance must never reverse that order. A link writer can update its account revision after holding doctor rows, so issuance takes all account/doctor rows before any revision. Proposed bind/revoke uses the exclusive fence then the same row order. Existing commission bookkeeping locks remain outside the authority proof; NOWAIT on authority witnesses avoids waiting behind a partially held writer chain. No writer changes or revision triggers are installed yet.

Implementation acceptance requires real `linkUserDoctor`, `updateUser`, and `updateParty` concurrency tests, not mock substitutes: hold account/doctor lock in a writer, attempt issuance and observe retryable denial, release writer and reject old revision; exercise A→B→A, concurrent revoke, absent revision and rollback on audit failure. These tests cannot truthfully pass before the deferred binding schema exists.

## Target installation witness and restore hold

The release's `scripts/restore-full.ts` validates an empty target and restores documents to DOCUMENTS_DIR staging; `scripts/restore.mjs` guards SQL restoration. Neither supplies a target-owned installation witness outside the restored data. Importing WORK's provenance machinery partially would change the authority boundary and is not part of this patch.

The minimal proposed witness is a non-secret random installation identifier held in a target-owned file outside SQL backups and DOCUMENTS_DIR archives. It identifies the installation only, never an owner. The explicit binding stores its digest; missing/mismatched file denies admission. A supported restoration must stop the application, rotate this target file before restoring, keep the restored binding quarantined, and require an explicit reviewed rebind before resuming on-behalf issuance. Copying both the database and this external file is outside that guarantee; no raw-clone detection is claimed.

No safe placement/exclusion/rotation integration is approved in the current restore contract. Therefore no witness file, environment setting, schema migration or live binding is created, and issuance as another doctor remains closed. Restore tools are unchanged. A future patch must review backup exclusions, target-file ownership and all supported restore entry points together before enabling the adapter.

No migration number is reserved for this owner-binding proposal. In particular, 0092 belongs to the prescribing-doctor snapshot. Future allocation must recheck all active branches and target history; this design introduces no schema.


## 2026-11-01: canonical integration boundary, not legacy activation

This earlier shared legacy-binding proposal is **not authorized for implementation**
in the current tranche. Do not create its relations, revision triggers, installation
file or provisioning command. Do not infer ownership from the username `admin`, an
administrative role, broad patient scope, an environment flag or staff-editable grants.
The requested owner/manager workflow remains unavailable until the canonical
foundation is coherently integrated; do not describe self-doctor binding as completion.

Exact inspected sources: Rx507 `258f0b9ef596383e64f7bf579f791a85e1b19656`
(tree `1c27b298708da16c3aeaabee31a63002a711f0c8`) and read-only WORK506
`1990b9666961e23a4e15dccd5919d868f6be2dc2`. WORK's actual owner proof is in
`lib/staff-authority-proof-internal.ts`, not a user-ID owner lookup. It requires the
active protected control/binding epoch, ready owner subject and identity history,
realm/generation/registry revision, canonical account/permission/credential epochs,
and active linked provider epoch. `staff-operation-runtime.ts` owns the shared
lifecycle fence and READ COMMITTED transaction; opaque handles bind client, XID,
exact action and authority fingerprint, with final revalidation before commit.

The catalogue contains `clinical.prescriptions.write`, but the inspected runtime
**does not admit that action**. `staff-session-admission.ts` selects a signed durable
canonical envelope without falling back to legacy on refusal. Copying only an owner
row reader or filling the released `loadCanonicalOwnerAuthority(userId)` placeholder
would omit those boundaries. The new transaction seam intentionally has only an
unavailable result and no provider setter/success factory. Legacy `SessionPayload`
is merely current caller context, never a substitute for `VerifiedDurableSession`.

### Minimum integration contract (pending, not an active provider)

1. Integrate the reviewed canonical admission, lifecycle writers, schema probes and
   restore/quarantine lineage as a coherent dependency; do not import all WORK or
   introduce a parallel Rx owner identity. No binding/provisioning is done here.
2. Register the exact Rx action in that runtime and obtain its protected-owner proof
   inside the same owning transaction as receipt reservation/replay and Rx/audit.
   Reconcile lock order explicitly: canonical lifecycle fence before domain locks;
   fresh admission after any receipt wait, final session/epoch check before commit.
   Do not nest a separately committing owner transaction inside issuance.
3. Keep regular clinician self-only and reception non-issuing. Validate the selected
   existing active doctor, fresh issuer link and patient/visit scope. Selecting a
   doctor changes only the immutable printed prescribing-doctor snapshot; the
   actual authenticated issuer remains separately recorded in audit and receipt.
4. Bind command identity/audit to canonical realm/subject/generation and protected
   binding version without rewriting legacy receipts or exposing saved IDs on
   conflict. Review replay after revocation/relink/restore before any activation.
5. The owner-selection preview is informational only. It cannot authorize issuance,
   recovery or reprint; every operation must use its own fresh exact authority.

### Acceptance gates

Implemented negative tests cover ordinary doctor and legacy admin (even with broad
patient access) selecting another doctor: refusal rolls back command/Rx/audit, self
issuance still works, and a fresh relink blocks cached replay/recovery without IDs.
The existing reception denial, inactive-provider, same-key concurrency, audit-failure
rollback and financial non-effect tests stay mandatory. Local in-memory tests are
not native PostgreSQL or built-browser evidence.

Pending positive canonical tests must prove the explicitly protected owner can
choose an existing active clinician while the printed snapshot and actual issuer
remain distinct, with no financial/commission side effect. Add real lifecycle writer
races, revocation/disable/relink/permission/expiry, cross-actor/key/payload conflict,
lost response, restore quarantine, exact audit lineage and saved-history preservation.
A mocked opaque access object does not establish those acceptance gates.
