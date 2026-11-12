# Canonical staff account writes: findings and proposal (owner decision 5, step 3)

Status: **Proposal A implemented for review** (review 6507696166 item 2; §5 below). Proposal B
stays design-only for M4. Nothing is installed or activated; no live database or account was touched.
It covers the "accounts" area of the unified settings (`UNIFIED_SETTINGS_INVENTORY.md`):
create, disable/enable, display profile, credential reset, role label, clinician link.

## 1. Findings (source as of this commit)

| # | Finding | Evidence |
|---|---|---|
| F1 | **No account can be created once the identity is ready.** Subject binding (`bindStaffAccountIncarnation`) runs only while `staff_identity_state.status = 'quarantined'`. In `ready`, the runtime schema guard refuses every identity mutation ("ready identity mutation requires a separately reviewed lifecycle"). | `lib/staff-identity-substrate.mjs` `state()`; `lib/staff-runtime-schema.mjs` guard |
| F2 | **Any binding would invalidate every session.** A binding increments the global `registry_revision`, and every durable session signs `registryRevision`; the proof refuses drift (`IDENTITY_NOT_READY`). Adding one receptionist would log the whole clinic out. | `lib/staff-authority-proof-internal.ts` `assertClaimsCurrent` |
| F3 | Account updates are already **self-revoking**: the 0076 trigger increments `authorization_epoch` on username, password, role, active, provider link, permissions and mode changes. The session also binds `credentialVersion` (password hash HMAC) and the provider tuple. A disable, credential reset, role change or link change refuses the target's existing sessions on their next request; the editor's exclusive fence serializes it with requests in flight. | frozen 0076 `staff_account_authority_epoch_guard`; `assertClaimsCurrent` |
| F4 | The owner account is protected by the database (no delete; the control row requires an active canonical administrator owner) and by the editor (the owner is never a target). | 0076 triggers; `lib/staff-capability-editor.ts` |
| F5 | Legacy writers (`/api/users` POST/PATCH, `createStaffUser`, `updateUser`, `linkUserDoctor`) are marker-held: they refuse on an authority footprint. They must not be reused as canonical writers (AUTHORITY_WRITER_CLOSURE.md). | `AUTHORITY_WRITER_CLOSURE.md` matrix |

## 2. Proposal A: updates of existing accounts (no schema change)

One authority-writer transaction per save, the same mechanism as the permission editor
(`/api/staff-access/[id]`): exclusive lifecycle fence first, fresh actor proof, locked
target, revision CAS, policy check, write, audit row in the same transaction, final
fresh proofs.

| Change | Requirement | Effect |
|---|---|---|
| Display name | `staff.profile.edit` | display only; no epoch change |
| Disable / enable | `staff.accounts.disable` | `is_active`; epoch increments, the target's sessions are refused |
| Credential reset (temporary password) | owner-only `staff.credentials.reset` | new hash; `credentialVersion` changes, the target's sessions are refused. There is no "must change at next login" flow today (the legacy path has none); adding one is an owner decision |
| Role label | owner-only `staff.role.change` | display label only (grants decide); epoch increments |
| Clinician link | owner-only `staff.clinician-link.change` | `party_id` to an active doctor party or none; provider tuple changes; `own` scopes follow the new link |

Rules:
- The owner is never a target; an actor never disables itself.
- A save combining several changes needs every requirement; one refused change refuses the
  whole save (the same batch rule as settings).
- Passwords never appear in audit rows or responses. Audit records the field names and
  before/after values for non-secret fields only.
- Tests: PG (each change, the batch rule, owner protection, self-disable refusal,
  revocation of the target's session, a request in flight serialized behind the
  exclusive fence, audit atomicity) and a built journey (editor UI → HTTP → DB).

## 3. Proposal B: creating an account in a ready identity (schema change, M4)

F1 and F2 make this impossible today without leaving `ready`. Options:

| Option | Effect | Assessment |
|---|---|---|
| B1. Return to quarantine to add a staff member | all sessions end; maintenance for every hire | operationally unacceptable (reception congestion) |
| B2. Ready-state incarnation with a **per-account** binding revision in the claims | the session signs the account's own `bound_registry_revision` (and the generation) instead of the global registry revision. A new binding changes nothing for other accounts; a rebinding of the same account still revokes it | **recommended** |
| B3. Keep global revision, re-issue all sessions silently | needs a token refresh path for every session; widens the issuer | rejected |

B2 needs:
1. Session claims schema version 3: `registryRevision` replaced by the account's
   `boundRegistryRevision` (generation still global). The parser refuses version 2 after
   the cutover (sessions re-prove).
2. A reviewed ready-state lifecycle in the runtime schema guard: in `ready`, only
   append-only binding of a **new, never-bound** account (`staff.accounts.create`), and
   retirement of a non-owner binding on disable-for-good, each under the exclusive
   lifecycle fence with CAS on `registry_revision`. Generation, realm, owner subject and
   control epoch stay immutable in `ready`. The history integrity check is unchanged.
3. The account is created `canonical`, active, with an empty capability document
   (revision 1, scopes `none`) and an initial credential set by the creator. The owner (or a
   delegate with `staff.accounts.create`, within its own authority) then grants through the
   normal editor; a starting template may fill that form.
4. Migration number: from our reserved range (0083–0086), never 0087; 0088/0089 stay
   Dot's. Registered with the M4 upgrade, restore and rollback rehearsal.

## 4. Order
1. Review of this proposal.
2. Proposal A (no schema change).
3. Proposal B with M4.

## 5. Proposal A as implemented (review 6507696166 item 2)

| Part | Where |
|---|---|
| Administrative target state, separate from the actor's session proof | `loadAdministrativeTargetState` in `lib/staff-authority-proof-internal.ts` |
| Pure policy (batch rule, owner, self, delegation bound, owner operations) | `validateStaffAccountChange` in `lib/staff-capabilities.ts` |
| Writer and read view | `lib/staff-account-editor.ts` |
| HTTP | `GET/PATCH /api/staff-access/[id]/account` |
| Screen | the "الحساب" section of `/staff-access` (`components/staff/StaffAccountEditor.tsx`) |
| Commission effect of a link change, in the writer's own transaction | `doctorCommissionChangeOn` + `doctorCommissionAuditInput` in `lib/db.ts` (the legacy `withDoctorCommissionChange` is the same code, its own transaction, audit after commit as before) |

**Target proof.** `loadLockedIssuanceAuthority` (the live login proof) is unchanged and still
rejects an inactive account or a stale doctor link. The editor never uses it for the target.
`loadAdministrativeTargetState` proves the ready control and intact history, then locks the
target row (`FOR UPDATE` in the writer, `FOR SHARE` in the read view), and requires a canonical
account with a parseable permission document and exactly one current subject binding. It
accepts an inactive account (to activate it) and a link to a doctor party that is no longer
active (reported as `stale`, to repair it). It returns the stored document only for the
delegation bound; the target is never resolved into a `ResolvedStaffAccess` and grants nothing.

**Order in one READ COMMITTED transaction.**
1. Transaction identity; `lock_timeout` 5 s.
2. EXCLUSIVE lifecycle fence first. There is no shared→exclusive upgrade: the writer does not pass through `withStaffOperation`.
3. Actor proof `loadExclusiveWriterAuthority(…, "staff.view")`: the full live session proof, with nothing relaxed.
4. Target lock and administrative proof.
5. The batch rule (`validateStaffAccountChange`):
   - every changed field needs its own authority, and one refused field refuses the save;
   - unknown fields and invalid values are refused before any lock;
   - fields equal to the locked value are not changes;
   - a password is always a change.
6. Version CAS. The CAS input is SHA-256 over `[id, username, displayName, role, is_active, party_id, authorization_epoch]`; the password hash is never part of it. The UPDATE repeats the epoch predicate.
7. An active account must be able to sign in. Activation, or keeping an account active, on a stale link is refused unless the same save repairs or removes the link (409 `stale-clinician-link`).
8. Write. A link change runs through the commission core:
   - parties are locked in id order;
   - baselines are taken before the write;
   - new snapshots are taken after it;
   - `doctor.commission.update` rows are written in the same transaction.
9. `staff.account.update` audit row in the same transaction:
   - `changes` holds before/after values for non-secret fields only;
   - `credentialReset` is a boolean;
   - `fields` and `sessionsRevoked` are recorded;
   - no password, hash or credential version.
10. Final checks: a fresh actor proof, the target re-proof, the same XID and the session's live clock.

**Revocation.** The frozen 0076 trigger increments the target's own `authorization_epoch` on an
active, role, link or password change, so only that account's sessions are refused. A display
name change is display only and keeps sessions. Other accounts' sessions are untouched.

**Authorities.**

| Field | Authority |
|---|---|
| `displayName` | `staff.profile.edit` |
| `active` | `staff.accounts.disable` (both directions) |
| `roleLabel` | owner operation `staff.role.change`. It is a label: the canonical resolver ignores it, and a test proves capabilities are identical after relabelling to `admin` |
| `clinicianPartyId` | owner operation `staff.clinician-link.change`. The target must be an active doctor party, or none |
| `temporaryPassword` | owner operation `staff.credentials.reset`. 8–1024 characters, hashed with `hashPassword` before the transaction. A forced change at next login is a separate policy and is NOT added |

A delegate never manages an account whose stored document is beyond its own authority.
The owner is never a target, and no actor changes its own account here.

**Tests.**

- PG `__tests__/postgres/staff-account-editor.test.ts` (13):
  - the read view per actor;
  - deactivation revokes only the target's sessions, with an audit row, and blocks login;
  - activation from inactive;
  - stale version 409; a display name change keeps sessions;
  - the batch rule, unknown fields and invalid values;
  - owner, self and delegation bounds;
  - a role label never grants;
  - a temporary password (owner only, no secret in audit or response);
  - relinking with commission history and audits; inactive or unknown doctor refused;
  - stale-link repair;
  - audit failure rolls back;
  - a request in flight by the target serialized against the exclusive fence, both orders.
- Unit `__tests__/staff-capabilities.test.ts` (account change policy, 3).
- Built journey `__tests__/security-http/canonical-account-editor-journey.test.ts` (3, portOffset 27):
  - HTTP refusals;
  - delegate deactivation and reactivation through the preview;
  - the owner relinks and resets the password in one save, with commission history and audits.
