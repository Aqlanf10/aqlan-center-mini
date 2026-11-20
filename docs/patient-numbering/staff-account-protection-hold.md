# HOLD: shared transactional staff account protection

Local candidate only. The product default is explicitly unconfigured and no
owner identity, password, grants, settings, migrations or deployment is created.
When the protected policy is supplied, it must load current immutable enrollment
via an existing branded trusted context on the same transaction. A missing,
malformed or inaccessible protected binding refuses, not legacy fallback.

## Scope and behavior

- `updateUser` and `linkUserDoctor` are the existing shared account writers.
  `/api/users/[id]` supplies the authenticated server session; request JSON cannot
  pass an owner context or choose mode. The guard applies to the entire generic
  patch before any write or financial history: bound owner rejects generic profile,
  credential, status, role, permissions/config and clinician-link changes. Even
  the bound owner uses a different action to change their own password. Current
  generic administrators retain their existing non-owner write scope; this is not
  a general replacement of existing RBAC with the preparatory capability catalogue.
- Shared lock order: staff-write transaction fence, protected binding loader,
  ordered actor/target final user locks, sorted existing commission party locks.
  Revalidate current role/credential/session after waits. The in-transaction
  last-admin check covers concurrent reductions through these shared writers.
  Clinician eligibility is checked under the party lock. The link API requires a
  positive ID or explicit null; malformed input is not treated as unlink.
- Generic account audit, field-specific permission/commission audit, commission
  history and staff-related party commission audit are on the same client and
  commit or roll back with the mutation. Commission before/after values use the
  locked preimage and committed-intent row. The response name projection is read
  before commit; no password hash is present in the response. Other commission
  callers retain existing behavior. Check session expiry after these awaits before
  releasing transaction callback; COMMIT still may finish after a wall-clock cutoff.
- `/api/auth/password` retains initial auth, validation/rate limit, and response
  policy. The separate self writer locks exact account, revalidates authority and
  verifies current password under lock, hashes only the requested new password,
  and commits mandatory audit before returning hash-free session reissuance claims.
  It never rotates another user or accepts a raw stored hash from the request.
  No global staff mutation fence for self-password because it cannot change the
  active-admin count. Old credentials fail subsequent revalidation; other session
  semantics are unchanged. Unconfigured means no new owner grant, not byte-for-byte
  old behavior: all touched account writes now require audit and enforce fresh role.

## Do not enable a real binding yet

The separately governed protected loader and owner enrollment do not exist. Both
numbering and all account writers must be wired to the same binding protection,
without an unconfigured escape in deployed callers. The fixture only injects a
synthetic opaque context and does not implement enrollment persistence. The older
`ensureSchema` startup path precedes protected write checks and can update users;
ensure protected-account compatibility before enrollment or mounting numbering.

Remaining application perimeter (not break-glass): ordinary `POST /api/users`
creation and initial setup need reviewed bootstrap rules (cannot infer/change owner
or resurrect bound identity), HR staff user links and the separate unmounted HR
identity apply need explicit protection for both link/unlink and compatible lock
order. Indirect clinician-party lifecycle writes and linkage/active state must be
reviewed alongside the canonical owner provider. These paths do not become safe by
mounting this guard; full route/HTTP and cross-writer races are still required.

**Privileged/CLI break-glass boundaries explicitly not covered:**

- `scripts/reset-password.mjs` performs a direct password-hash update. Govern any
  bound-owner recovery as separately authorized, possession-proven, audited and
  revoking previous authority/session material; do not expose this as an ordinary
  administrator or shell fallback. No script changes or execution here.
- Bootstrap/maintenance DDL, demo seed, role/doctor-link backfill and provisioning
  can write outside the shared command fence. Verify safe startup and locked
  maintenance before any real owner exists.
- PostgreSQL privileged users, direct SQL/console changes, assignment of DB roles,
  restore/import/cutover and cluster snapshot rollback require separate access and
  identity/lineage/revocation policy. Application row locks are not a database-role
  security boundary. No live SQL or restore was performed.

No full CI, HTTP/browser approval, restore, migration or live access is claimed.

## Local evidence

Node 22.23.3: 37 PostgreSQL 18.6 tests pass (10 shared writer, 14 same-client
owner provider, 13 original adapter) in a freshly owned disposable loopback
instance. Proved mixed owner refusal, bad binding, ordinary non-owner edit,
last-admin race, invalid doctor link, self-password race and audit failure,
detailed companion audit rollback and expiry during an observed audit lock wait.
A separate 43 unit tests for self-password response/session/preflight pass.
Targeted strict TypeScript passes; targeted lint reports no errors and eight
pre-existing unused-symbol warnings in the large shared DB module.
