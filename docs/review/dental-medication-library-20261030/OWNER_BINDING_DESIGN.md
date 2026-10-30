# Central clinic owner binding — design awaiting review

Status: proposal only. No schema, provisioning command, owner identity or live grant is implemented by this document. The Rx owner adapter still returns null. Ordinary clinician issuance and reception reprinting remain independently usable under their existing checks.

## Evidence and allocation

Read-only comparison on 2026-10-30: candidate has migrations through 0091; WORK `0bc3a0c57f57a8d0ed9f3cebd1cf56a1e19b11a4` contains the canonical authority runtime and its identity substrate; #490 at `cba42c1c864fd900f6faf43b90ef2f894b1e137e` allocates 0080 for patient numbering. Neither inspected tree has 0092. **0092 is only a candidate number, not a reservation**: parent must coordinate allocation with other in-flight branches before any SQL file is created.

WORK `lib/legacy-staff-schema.mjs` selects canonical mode on ANY enumerated authority table/function/trigger or `users.authorization_mode`, `users.authorization_epoch`, `users.staff_subject_id`, `parties.clinical_authority_epoch`. No such artifact, ready seal, login marker or canonical permission document may be created by this proposal. Its `readStaffEntryMode` is SELECT-only and fails on unreadable state; selection is deployment-wide, not a fallback per failed request.

The current `savePrescription` in `lib/db.ts` inserts with the pool and starts `void recordAudit(...)` separately. That is **not atomic audit** and must be refactored before on-behalf issuance is admitted. The current read-only owner adapter plus mocked opaque resolver tests is not a functioning owner feature.

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

The release base does not yet expose WORK’s shared mode selector. Review must explicitly authorize reuse/extraction of its SELECT-only detector (and schema-name validator) into the central adapter; no tables, ready state or activation runtime would be copied. A duplicated guessed marker list is not an acceptable long-term mode authority.

Main review decisions: allocation of the migration number; acceptance of shared revision tracking; exact provisioning operator authorization; restore/quarantine contract; and the canonical runtime integration/cutover owner. These are unresolved design choices, not permission to provision a real owner.
