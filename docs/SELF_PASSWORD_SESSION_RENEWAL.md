# Self-password session renewal for restricted finance roles

## Confirmed defect and bounded repair

`POST /api/auth/password` generated a new credential fingerprint after a successful
self-service password change, but omitted the `financeAccess` and
`permissionVersion` claims already issued by `POST /api/auth/login`.
`lib/session.ts` requires the permission fingerprint for cashier/accountant
accounts, so their replacement token was rejected on its next authenticated use.
The omission also meant the proxy could not read the account's signed per-user
finance limits. This is a source and synthetic regression finding, not a claim
that a real Production account or credential was exercised.

The repair is confined to `app/api/auth/password/route.ts`. It reuses the existing
`createSessionToken` and `sessionPermissionVersion` functions, matching login's
restricted-role claims. Identity, role, linked party and normalized finance
permissions come from the account returned by `updateUser`; the credential
fingerprint continues to use the new password hash written by this request.
Cookie attributes, response confidentiality and audit behavior are unchanged.

No database implementation, schema, permissions editor, role ceiling, grant,
authentication primitive or capability rollout is changed.

## What the returned account and concurrency tests prove

`updateUser` returns its `UPDATE ... RETURNING` row, including role, activity,
party and permissions, with permissions normalized by `parseDoctorPermissions`.
It is a saved-row snapshot, **not** a fresh active-only lookup, and does not return
the password hash. A concurrent deactivation can therefore still produce a
signed replacement cookie, but `requireSession` rejects its use: the subsequent
active-user lookup and explicit activity, role and credential checks are retained.

The new tests deterministically place a deactivation during the update and a
competing password change after this request's update but before token issuance.
They exercise the real signing, cookie and `requireSession` implementation with
mocked database persistence. Both replacement tokens are rejected on subsequent
use. Additional tests preserve current permissions/role/party returned during the
update and verify that a later permission change revokes the renewed session.
These are mocked race-ordering tests, not PostgreSQL concurrency tests.

**Unchanged limitation:** current-password verification and the database update
are separate operations. A competing password reset that completes between this
request's verification and its write can be overwritten by this request. The
existing writer is last-write-wins; this repair neither adds a compare-and-swap
condition nor claims to fix that earlier race. A conditional credential update
would need a separately reviewed database change. By contrast, a password change
that lands after this request's write makes this request's fingerprint stale and
is rejected by the retained session check.

## Local verification and exact focused test set

The initial regression suite reproduced eight failures against the original
route, while seven unaffected cases passed. The final suite contains 21 new
cases, covering all six roles; default, all-false, mixed and maximum finance
inputs; fixed role ceilings; real server/proxy token verification; old-token
revocation; successful login with the changed synthetic password; cookie
attributes; rejection/failure paths; and the bounded ordering cases above.

The following Node 22 command passed **54 tests in five files**:

```sh
node node_modules/vitest/vitest.mjs run \
  __tests__/self-password-session.test.ts \
  __tests__/session-revocation.test.ts \
  __tests__/role-routes.test.ts \
  __tests__/security-routes.test.ts \
  __tests__/security-rate-limit-and-cookies.test.ts
```

| Suite | Tests |
|---|---:|
| `self-password-session.test.ts` | 21 |
| `session-revocation.test.ts` | 5 |
| `role-routes.test.ts` | 7 |
| `security-routes.test.ts` | 11 |
| `security-rate-limit-and-cookies.test.ts` | 10 |
| Total | 54 |

Targeted ESLint, focused TypeScript covering the changed route and new tests,
and `git diff --check` passed. Independent source/security review found no
blockers; the unchanged last-write-wins limit above was explicitly reviewed.

## Release status and verification boundary

Status remains **PARTIAL**: exact-head full CI/build, merge, and read-only
Production deployment/health verification are pending. No local full build,
built-HTTP runtime proof for the added cases, real password change, live grant
change or Production credential test is claimed. Publication remains queued
behind the active release slots. Production verification must not change an
actual account password or credential.
