# M1 canonical entry slice: issuance, session admission, directory and permission editor

**Status: WORK, submitted for review. Readiness stays NOT_READY.** This slice adds code that runs only against a schema carrying the canonical authority footprint. Every test uses synthetic fixtures. Nothing here installs schema, binds a real owner, grants anything live, enables a public toggle or deploys.

Read with:
- `CONTRACT.md`;
- `OWNER_READINESS_AND_ISSUANCE.md` (§5 issuance, §4 lock order);
- `CANONICAL_READ_SNAPSHOTS.md`;
- `AUTHORITY_WRITER_CLOSURE.md`.

This document is the issuance and read design that `CONTRACT.md` step 2 requires before the slice. It does **not** treat the existing organisational extraction as design approval. Review is requested on every item in §6.

## 1. Entry selection: one rule per deployment and one per request

**Deployment mode** comes from `lib/legacy-staff-schema.mjs:readStaffEntryMode`, a SELECT-only catalogue footprint count shared with `readLegacyStaffSchema`.
- Zero markers means `legacy`: the existing login is unchanged.
- Any marker means `canonical`: only the private issuer may act.
- An unreadable catalogue throws, and the route returns a server error. It is never treated as "absent".
- There is no per-request fallback. A partial, quarantined or drifted canonical state answers "maintenance" (503) before any password work, so it cannot reveal whether a credential is valid.

**Request envelope** comes from `lib/staff-session-admission.ts:selectStaffEnvelope`, which applies one rule:
1. A cookie with a valid signature is selected first.
   - If it carries canonical markers, it is `canonical` when the strict durable parser accepts it, and `denied` otherwise. It never falls through to a Bearer token.
   - A marker-free cookie is `legacy`.
2. With no valid cookie, a signed Bearer token is classified by the same rule.
3. Otherwise the request has no envelope.

`readSessionPayload` keeps its existing refusal of a canonical cookie on the legacy path.

## 2. Password-authenticated durable issuance (§5)

The issuer is `lib/staff-durable-issuer.ts`. Its only importer is `app/api/auth/login/route.ts`, enforced by an AST test. The steps:

1. **Readiness preview, SELECT-only.** Exact v2 catalogue, active control, ready state, and realm/epoch alignment. If any fails, the result is `unavailable` and no limiter or scrypt work runs.
2. **Both persistent limiter layers.** These use the same keys as legacy (`loginLimitKeys` and `legacyStaffAccountKey`) and the same SQL (`lib/login-limit-storage.ts`; the legacy `db.ts` functions now delegate to it after `ensureSchema`). There is no `ensureSchema` on the canonical path, no in-memory bypass, and a missing table fails closed.
3. **Candidate lookup, non-initialising and minimal.**
   - Case-insensitive username, active, `authorization_mode='canonical'`, `LIMIT 2`.
   - An ambiguous match, an over-long input or an absent account gets one dummy scrypt derivation.
   - `verifyPassword` runs outside any lock. The issuer captures `{id, username, password_hash, authorization_epoch}`.
4. **Locked proof.**
   - READ COMMITTED, then XID capture, then the shared transaction fence, then `loadLockedIssuanceAuthority`.
   - That call proves control → identity state → history → users (FOR SHARE, sorted) → bindings → provider → strict permission document → resolved access.
   - The captured candidate must equal the proved row exactly. If anything changed, the attempt fails as an ordinary bad credential and nothing derived from the old proof is used.
5. **Claims derived only from the proved tuple.**
   - `expiresAt` uses `SESSION_DURATION_MS`.
   - Signing goes through the private `signDurableSessionClaims`, which accepts the exact key set only and is separate from `createSessionToken`.
   - The token is then round-tripped through the strict durable parser.
6. **Commit sequence.**
   - Atomic, non-secret audit (`auth.canonical_login`).
   - A fresh second proof, which must equal the first.
   - An unchanged XID.
   - A wall-clock expiry check.
   - COMMIT.
7. **After commit only.**
   - The route sets an HttpOnly, Lax cookie under the existing Secure rule, with bounded `maxAge`, and responds `no-store`.
   - The token is never placed in JSON.
   - Account counters are cleared best-effort; source counters are left alone.

If signing, auditing, the final proof or COMMIT fails, the transaction rolls back and no token leaves the issuer.

After a password match, every refusal (a malformed document, an inactive provider, a racing lifecycle change) answers exactly like a wrong password. Only the reason code is logged server-side.

Entry requires **no capability**: the issuer does not invent a `staff.view` requirement.

## 3. Live session admission: auth/me and the shell

`admitCanonicalStaffSessionIn` runs READ COMMITTED, then the shared transaction fence, then `loadLockedSessionAuthority`.
- This is the same tuple comparison as operation admission, without an action gate.
- It returns a display projection: username, display name, role **label**, owner flag, exact capability list, scopes and linked provider.
- The projection is presentation only. Every operation re-proves its exact capability.

Callers:
- `app/api/auth/me` answers `canonical:true` with this projection, or 401.
- The root layout uses it for canonical envelopes and never calls `requireSession` for them.
- `components/CanonicalShell.tsx` renders only pages listed in `lib/canonical-navigation.ts`, filtered by current grants, and calls no legacy endpoints (no badges, search or shortcuts).

Any page that has not been migrated shows a workspace notice instead of its legacy UI. Revocation is effective on the next live admission: a stale cookie fails at auth/me and at every route.

## 4. Staff directory and permission editor

**Directory.** `GET /api/staff-access` reuses Dot's `readCanonicalStaffDirectory`:
- session-level shared fence **before** `BEGIN REPEATABLE READ READ ONLY`;
- virtualxid identity probe;
- bounded pages;
- disposal on uncertainty.

**Editor.** `lib/staff-capability-editor.ts` is a transaction-owning authority writer. Its order:
1. Exclusive transaction fence **before any row lock** (`lock_timeout` 5s). There is no shared→exclusive upgrade, and it does not use `withStaffOperation`.
2. Actor proof with exact `staff.permissions.edit`.
3. Target proof, then the target row `FOR UPDATE`.
4. `validateStaffCapabilityChange`, which refuses self-edits, the protected owner, peer delegators, anything outside the actor's delegable authority, missing prerequisites and stale revisions.
5. `UPDATE … WHERE revision = expected` (compare-and-set).
6. Atomic audit, recording added and removed grants and scope changes.
7. Fresh actor and target proofs, XID check, expiry check, COMMIT.

The fixture trigger raises the target's `authorization_epoch`, so its live sessions fail on next admission.

`GET /api/staff-access/[id]` runs under `withStaffOperation("staff.permissions.edit")`. It returns `editable`, `delegable` and `scopeOptions` computed by the **real policy** (a no-op revision check), not by UI guesses.

The routes are registered under a new `canonical` access class:
- every legacy role is always denied (`rolesAlwaysDenied`);
- the proxy only requires a session to be present;
- the handler admits.

## 5. Evidence on this head (local, synthetic)

| Suite | Covers |
|---|---|
| `postgres/staff-durable-issuer` (14) | exact token shape and runtime admissibility; owner entry without an invented grant; wrong, missing, inactive, ambiguous and over-long inputs; both limiter layers, with account-only clearing; password or permission change committed while issuance waits on the fence; malformed document and inactive provider; audit failure yields no token; protected owner rows; quarantined, unsealed and drifted schemas answer `unavailable` with no limiter use |
| `postgres/staff-capability-editor` (9) | projection; owner edit with audit, live-session revocation and fresh login; manager delegation limits (self, owner, peer, non-held grant, delegation itself); stale CAS; missing grant; exclusive fence waits behind an admitted shared reader and blocks issuance; audit failure rolls back the write; expiry during the fence wait; stale or copied handles |
| Existing runtime, directory and inventory canonical suites | 218/218 after the shared-proof refactor |
| `durable-signer-boundary`, `staff-session-selection` (unit) | signer allowlist (names, namespace, dynamic and wildcard imports); strict shape; selection rule; labels; navigation projection |
| Built-app journey `security-http/canonical-entry-journey` (6) | runs on its own canonical-fixture database and server. Covers: cold `/login`; generic 401s with persistent limiter rows; cookie-only issuance (HttpOnly, Lax, `no-store`, no token in JSON); auth/me projection; legacy token refused on canonical routes and canonical cookie refused by legacy routes, with no Bearer fallthrough; browser owner login → canonical shell → unmigrated page shows the workspace notice with **zero legacy API calls** → directory → grant; the target's earlier cookie gets 401 while a fresh login shows exactly `staff.view`; direct editor read and self-escalation get 403; audit row; delegated manager limits and stale CAS 409; mobile 390px navigation with no horizontal scroll; logout clears the cookie. A `ddl_command_start` event log stays **empty** for the whole run, cold server start included. |
| Regression on this head | Unit: 792 files. PostgreSQL: 34 related files / 562 tests. HTTP: permission matrix, session, self-password, login-limit reset, settings authorisation and the journey (46 tests). The 15 HR/lab/leadership suites failing on `b4bd7979` pass after the `server-only` fix (one timing cascade passes on rerun). |

## 6. Open decisions and their fate before any activation

| Decision | State | Owner of the decision |
|---|---|---|
| §2 owner trust root: who approves owner binding, independent identity verification, where approval evidence lives, two-person rule | **Open.** No preparation service exists, and synthetic provenance stays test-only. | Clinic owner, with an organisational change-control choice |
| Admission policy ownership: which capability each existing route and branch requires; record reassignment semantics (does a patient or provider reassignment revoke record eligibility immediately and join the exclusive fence?) | **Open.** M2 proposes a per-route capability map for review; reassignment is treated as an authority write until decided. | Owner, with Dot's review |
| Authority-writer closure: `scripts/reset-password.mjs`, maintenance CLIs, restore/setup paths and trigger interactions all take the exclusive fence or are refused in canonical mode | **Open.** Enumerated in `AUTHORITY_WRITER_CLOSURE.md`; the editor is the only canonical writer added here. | Dot's review |
| Logout | **Decided for the first slice, pending confirmation.** Logout clears the cookie in the browser only. Account-wide revocation goes through an authorised epoch mutation (editor or credential change). Per-session server revocation needs a session-record schema and is **not** claimed. | Owner, to confirm whether per-session logout is required |
| Required workflow list (which existing routes must pass marker-bearing journeys before cutover) | **Open.** The inventory lists 411 methods and 95 pages; an owner-confirmed list is still needed. | Owner |
| Maintenance vs zero downtime | **Decided by the owner:** a drained maintenance window on a clinic holiday. Date to be scheduled; duration from the M5 rehearsal. | Done |
| Frozen catalogue vs the real clinic schema | **Proposed fix, for review.** On a database bootstrapped by `ensureSchema`, the only substrate catalogue drift was the SERIAL default on `users.id`/`parties.id` (`nextval('…_id_seq'::regclass)`), which the earlier synthetic capture pinned as `null`; `initializeStaffIdentitySubstrate` therefore refused the real schema with `STAFF_IDENTITY_SCHEMA_DRIFT`. Revision: both catalogues now pin the clinic's SERIAL default; the probe normaliser treats the schema-qualified spelling of those two owned sequences as identical; every synthetic fixture creates `users`/`parties` with `SERIAL` ids like production. The built-app journey now installs on the unmodified real schema. No other catalogue entry changed. | Dot's review of the revision |
| Restore of inventory authority (`inventory-authority-restore`) | **Open; needs a reviewed target-side protocol.** Source realm and execution history must not be imported (§2/§6). Target-local rebinding is required. | Dot's review |

## 7. Corrected milestone dependencies (after review 6458434508 and 6458475203)

**M0 is not closed by issuance.**
- `inventory-authority-restore` and `inventory-supplier-operational` remain red on purpose.
- They sign the obsolete `authority` marker, and `lib/inventory-domain/authenticated-session.ts` still takes `SessionPayload` with the old envelope.
- They turn green only when supplier admission, runtime and restore move to the canonical runtime (M3a below). They will not be patched with a cast, a test signer granting old authority, or a role fallback.
- Positive supplier and restore effects stay covered.

The revised order:
1. **M1 (this slice):** issuer, admission, shell, directory, editor, built-app journey.
2. **M3a:** inventory supplier, procurement admission and runtime on `withStaffOperation` with new exact capabilities; a reviewed target-side restore protocol replaces source-authority import. This closes M0's two tests.
3. **M2:** a per-route capability map and canonical admission for the remaining clinic routes and pages, in dependency order (patient/clinical/appointments; finance; HR/tasks; backup/export).
4. **M3b:** the full inventory and procurement completion, with all 69 scenarios.
5. **M4:** schema registration.
6. **M5:** Staging rehearsal and runbook for the holiday window.
