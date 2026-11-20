# HOLD: same-client owner session provider

This is local engineering evidence. No app route, authorization grant, real owner
binding, credential setup, allocator caller, migration or deployment is activated.

## Implemented scope

- `readBoundRequestSession()` uses the existing signed cookie/Bearer admission,
  with additional strict token shape and numeric/expiry checks for this lane. A
  process-local branded handle rejects arbitrary payloads or copied JSON. The
  server-private digest binds the exact existing signed credential. No new
  signing secret, account, static password or token issuance is added. Existing
  `readSessionPayload()` and `requireSession()` retain their behavior.
- `createNumberingOwnerSessionProvider(proof, bindingLoader)` defaults to deny.
  The optional, separately governed loader is given the same PoolClient and must
  return existing opaque `TrustedOwnerContext`. No default admin, username, live
  config lookup or fallback canonical document exists here.
- Actual account authentication is refreshed with `revalidateSessionInTransaction`
  and the existing user SHARE lock. The provider reads raw canonical permissions
  on that client rather than reconstructing from the legacy profile projection;
  missing/malformed/legacy profiles refuse. A non-null clinician party linkage is
  checked and locked on the same client. The canonical resolver decides owner.
- The current backend locks configuration, then gives exactly the same client to
  the binding/user/party provider, receipt lookup, snapshot, apply/audit and commit.
  Controller uses this paired access/session evidence without abstract fallback
  once the backend-native provider is installed. A provider exception rolls back.
- Existing abstract/fixture command interfaces remain usable; existing app flows
  do not import the provider or opt in. The direct command is not the future HTTP
  boundary; only the reviewed controller enforces preview binding there.

## Mount blockers and exact wiring sequence

1. Protect the owner account **before** permitting the numbering route or real
   owner enrollment. Generic admin account PATCH presently writes credentials,
   role, active status, permission data and clinician links; possession of the
   owner's ID is not proof of the original person after a takeover. Per-command
   password-hash/role checks revoke old credentials but cannot distinguish a new
   legitimate-looking session obtained after an unauthorized credential reset.
   Existing account-control preflight is not wired and is not a database guard.
2. Integrate guarded writers atomically: resolve fresh actor/target + trusted
   binding, lock in documented global order, check binding/permission revisions
   and reject forbidden owner changes, then mutate and audit on one client.
   Cover account PATCH and clinician link, user creation and setup paths,
   self-password/recovery (verify current credential under lock, issue new login
   only after commit), HR links, reset-password maintenance, seed/bootstrap and
   restore authority. Protect the stored binding itself. Prove the actual writer
   lock order and last-admin invariant; no mutable settings owner ID or first-admin
   heuristic. Restore and out-of-band maintenance need a separate governed trust
   boundary, not just application-route checks.
3. Provision a separately approved protected binding lifecycle/version outside
   staff-editable data. Its loader must read/lock fresh authority using the passed
   PoolClient, not a cached role, env boolean, second pool or client data. Confirm
   who may own the operation and how to handle canonical profile admission,
   owner-role changes and cookie/Bearer scope. Do not activate the wider canonical
   permission system merely for this flow.
4. Decide session policy. The digest distinguishes exact signed credentials, not
   independently revocable login IDs. Existing tokens are deterministic: two
   sign-ins with identical claims/expiry may produce the same credential, and
   logout clearing a cookie does not revoke copied credentials server-side.
   Distinct login isolation/immediate logout revocation requires an explicit
   existing-auth extension before mount if required. Role, active and credential
   changes are already read fresh on the locked account; binding/profile revision
   changes invalidate prior fingerprint. Same credential on cookie and Bearer
   has the same digest; do not construe this as a decision to allow both transports
   in a future browser-settings endpoint.
5. After the first four are proved, build separately reviewed preview issuance and
   verifier with exact user, authority, signed-session proof, revision, normalized
   command and expiry. Require verified server Request admission, bounded JSON,
   same-origin/CSRF as appropriate, private/no-store responses and exact retry
   handling. A verifier is not authorization on its own. Avoid exposing raw token,
   credentials or authority internals to the browser. Only then consider an
   authenticated, unmounted synthetic end-to-end route composition.
6. Separately finish official backup/restore and lineage, all allocation/reset
   paths, full required candidate CI, and gated Staging acceptance. This artifact
   is not merge/deploy approval.

## Evidence limits

Node 22.23.3: 27 PostgreSQL 18.6 tests passed (14 new provider tests and 13
existing adapter tests) on a dedicated fresh loopback instance, including an
observed allocator lock wait before credential revocation. The cluster stopped
after the run. A separate 100 focused unit tests passed. Tests
use random ephemeral synthetic credentials and owned fixture schemas only. The
current binding store is a test callback, and preview verification is synthetic;
real issuer, HTTP, real owner, account protections, backup, full CI and deployment
are outside the test. Existing role/credential session regression and focused
TypeScript/lint are also exercised locally. Do not upload incomplete code.
