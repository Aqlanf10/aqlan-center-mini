# Phase 2 local implementation — unregistered, not activation

Base: frozen phase 1 `acf12d3589a845eff63c4139f0caa272b5b78596`.
Separate worktree: `rebuild-staff-runtime-20261027`.

## Scope and ownership

New durable-session verifier, operation runtime, unregistered version-2 schema/descriptor, dedicated unit/PG fixtures and documentation. A narrow legacy `auth.ts` token-marker containment change requires explicit compatibility tests. No login, owner preparation/issuer, UI, route, inventory integration, migration registration or Production change.

## Approved bounded readiness design (concrete schema review pending)

Phase 1 is always quarantined and cannot produce a positive runtime admission. A separate explicit v2 schema may evolve the actual identity-state contract; a companion receipt must never override quarantine. Applying v2 DDL alone must leave existing state quarantined and cannot select an owner or grant access.

The v2 descriptor must be distinct and exact. Add immutable ready-owner subject and control-binding epoch anchors to identity state. Ready state must agree with current target realm/generation, active frozen0076 control and exact owner incarnation, not merely numeric owner ID. No exported readiness transition or token issuer is introduced. Phase1 mutators remain unchanged and reject v2 via strict descriptor mismatch. Ready mutation/reset/recovery is outside this slice. The readiness seal does not increment registry revision: complete history accounting remains generation count plus binding-event count. Ready state forbids generation/realm/anchor mutation and the existing quarantine guards block new subject/event/current-binding writes.

Positive synthetic PostgreSQL fixtures can explicitly construct the reviewed ready-state shape to test runtime admission. These fixtures prove no operator authority, bootstrap, recovery trust or real account activation. Existing frozen0076 bytes remain unchanged; tests must not disable guards or use transient prepared placeholders as authorization evidence.

## Implemented token boundary

A separate verifier parses a bounded signed durable token only after HMAC verification and strict exact-field validation. Claims bind schema/policy version, realm, immutable subject, target generation, registry revision, control binding epoch, account authorization epoch, credential HMAC, permission revision and linked provider tuple/clinical epoch (or explicit null). Expiration must be finite and strictly future. Username is display/provenance, never ownership.

The verifier returns a private WeakMap-backed handle, not caller-constructible claims accepted as authority. No production signer is exported. Synthetic tests sign fixtures explicitly. A shared signature-envelope verification primitive preserves existing secret/HMAC semantics and requires exactly two token segments; no suffix segments are ignored.

Legacy token reads reject durable markers so a canonical owner cannot enter through legacy handling. Obsolete `authority` and `staffAuthority` claims are rejected, including mixed tokens. Ordinary marker-free legacy sessions retain current behavior. Existing obsolete v10 consumers must remain closed; compatibility failures are diagnosed, not papered over with global fallback or unsafe casts.

## Implemented operation boundary

`withStaffOperation(pool, verifiedSession, exactAction, callback)` owns the READ COMMITTED transaction via the existing helper. It admits a private handle before invoking the callback; `assertStaffOperation(client, handle, exactAction)` is required before protected SQL. The wrapper freshly asserts again immediately before returning to the helper's COMMIT and invalidates the handle in finally. There is no exported raw admission API.

Handles bind the exact client, PostgreSQL top-level XID, action and original verified signed token. Every assertion reacquires the central authority fence and validates fresh authority. XID is explicitly not a subtransaction identifier. Normal callback savepoints occur after authority fences. Trusted callbacks must not issue top-level COMMIT/ROLLBACK/BEGIN: changed/ended XID is rejected, but a malicious earlier commit cannot be undone. Caller-owned transaction composition would require a separately reviewed precommit contract.

Use explicit READ COMMITTED transactions. Runtime uses a shared advisory fence on the exact phase1 exclusive lifecycle key. Lock order is authority fence → control/state → account/current subject/provider → future domain locks. Each assertion freshly checks v2 descriptor, complete immutable history, ready anchors, current target generation/binding, active canonical account, credential/account/provider/control revisions, policy/document validity and explicit capability. Owner authority derives only from exact protected owner binding; it never authorizes legacy entry. Display booleans and projections cannot be operation inputs.

## Required evidence

- V1 quarantine, v2 quarantine, missing/partial/mixed/v10 schemas and incomplete ready anchors deny.
- Signed token tampering, extra/obsolete/mixed markers, expired/unknown version claims deny; ordinary legacy remains compatible.
- Synthetic positive exact action admission and fresh revalidation.
- Wrong client/action, copied handle, COMMIT/new BEGIN reuse, savepoint boundary, account reincarnation, stale generation, password/permission/provider revocation and expiry during lock wait/after write deny.
- Rollback preserves atomic writes when final assertion fails.

No pass here constitutes authorization to prepare an owner, activate routes or import source authority.


## Legacy integration remains closed

Removing obsolete claim issuance from legacy login/password renewal preserves their ordinary marker-free behavior; it is not canonical login integration. Before any real canonical conversion/activation, every legacy handler must freshly classify database account authority and refuse canonical accounts even when presented with an older marker-free token. Marker parsing alone does not establish global legacy isolation. No accounts are converted by this slice.

## Current local evidence

The synthetic runtime fixture explicitly constructs a hypothetical trusted-ready state using the frozen control transition shapes. It is not an operator trust or bootstrap test. Version-2 installation itself remains quarantined. Full readiness lifecycle, source restoration and any ready-state reset are unsupported.


Signed username is compared to the freshly loaded label only for stale-session consistency. It never selects the principal or establishes historical ownership: selection is immutable subject/current binding. A renamed account can use a fresh signed session with the same subject. Future journal recovery must preserve original stored username as provenance, not rewrite it to the current label.
