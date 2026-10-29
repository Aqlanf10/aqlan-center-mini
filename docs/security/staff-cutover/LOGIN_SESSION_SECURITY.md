# Staff login and session security: logout revocation and login audit (design for review)

Status: **design for review** (review 6507696166 item 7). There is no behaviour change in this
commit. Tests characterize today's behaviour (§4) and are expected to flip when the reviewed design
lands. MFA is out of scope.

## 1. Findings (source as of this commit)

| # | Finding | Evidence |
|---|---|---|
| S1 | **Logout only clears the cookie.** A copied canonical token stays valid until its `expiresAt`, or until its account epoch, credential, permissions or provider change. It also survives the logout of the browser that held it. | `app/api/auth/logout/route.ts`; `lib/staff-durable-session.ts`: the claims carry no session identifier |
| S2 | **Failed canonical logins are not audited.** They are counted by the HMAC-keyed limiter only (`staff_login_limits`, `login_limits`). A successful canonical login is audited atomically (`auth.canonical_login`). | `lib/staff-durable-issuer.ts` |
| S3 | **Logout is not audited.** | logout route |
| S4 | Legacy path: successful and failed logins are not audited (an open owner decision noted in the route). The legacy path ends at cutover; this design does not change it. | `app/api/auth/login/route.ts` |
| S5 | The responses already avoid enumeration: one Arabic message for an unknown user, a wrong password, an inactive account and post-password refusals. Unknown users still pay a password-verification cost. | login route, issuer |

## 2. Proposal

### 2.1 Per-session revocation on logout (recommended: R-a)

| Option | Effect | Assessment |
|---|---|---|
| **R-a. Session identifier + revocation list** | Claims v3 gain `sessionId` (random UUID, issued in the issuer transaction). Logout inserts `(session_id, user_id, expires_at)` into `staff_session_revocations`, and admission refuses a listed id. Rows are dropped after `expires_at`. | **Recommended.** Only the logged-out session ends; other devices of the same person stay signed in. |
| R-b. Logout increments the account epoch | Every session of that account ends ("log out everywhere"). | Rejected as the default: a doctor logging out on the reception PC would also end the session on their own phone. It can be offered later as an explicit "log out all devices" (owner decision). |
| R-c. Shorter token lifetime only | Narrows the window; does not close it. | Not sufficient alone. |

R-a details:
- **Schema:** one table and one index on `expires_at`. The migration number comes from our reserved range (0083–0086), never 0087, 0088–0089 or 0090. It is registered with the M4 upgrade, restore and rollback rehearsal.
  - It is an authority relation: the restore replay must not import it (B1).
  - It is part of the footprint catalogue.
- **Claims v3** are coordinated with B2 (per-account `bound_registry_revision`, review item 3). This gives one claims transition instead of two.
  - v2 tokens are rejected only within that coordinated transition, with a proven rollback, as item 3 requires.
- **Logout:** under the shared lifecycle fence, verify the presented token. Then INSERT its `sessionId` (idempotent), audit `auth.logout`, COMMIT, and only then clear the cookie.
  - An invalid or expired token still clears the cookie and answers 200. It writes no row and leaks nothing.
- **Admission:** one indexed `NOT EXISTS` on the revocation list in the same proof as the other anchors. That covers operations, owning readers, writers and the session admission owner.
- **Serialization:** a request admitted before the logout committed may finish. This is the same semantics as today's epoch revocation, which is ordered by the fence, and a revoked token is refused on its next admission.
- **Cleanup:** expired rows are deleted opportunistically by the issuer (bounded: at most 100 per login) under the shared fence. There is no background job.

### 2.2 Audit of failed logins and logouts without leaking account information

| Event | Row | Never stored |
|---|---|---|
| `auth.login_failed` (canonical) | `details.reason` ∈ `invalid_credentials`, `rate_limited`, `unavailable`; `details.accountKey` = the existing HMAC account limiter key (stable per username, not reversible without the server secret); request source per the existing `currentAuditSource` trust rules | the typed username, the password, whether the account exists, whether the password matched before a later refusal |
| `auth.logout` | the session's `userId` and `username` (from a verified token only), `sessionId` | token, credential version |

- **Bounded volume:** at most one `auth.login_failed` row per account key and source per limiter window per reason. `rate_limited` is recorded once, when the window first refuses, so a flood cannot grow the audit log beyond the limiter's own rows.
- **No oracle:** the failure row is written for an unknown user and for a known one alike, in the same code path and after the same password cost. The response is unchanged.
- **Viewing:** the rows join the security filter of the audit screen. `auth.login_failed` is labelled «محاولة دخول فاشلة» without the account identity. An owner can compare `accountKey` values for patterns, not names.

### 2.3 Not in scope
- MFA.
- A forced password change at next login (a separate owner policy; review item 2).
- Legacy path audit (S4; it ends at cutover).
- Remembering devices.

## 3. Order of implementation (after review)
1. Claims v3 together with B2, in an isolated design and tests (M4).
2. The revocation table, the logout writer and the admission check, with PG proof:
   - the copied token is refused after logout;
   - other sessions of the same account stay valid;
   - a request in flight completes;
   - expired rows are purged;
   - restore does not import the table.
3. Failure and logout audit, with PG and built-journey proof:
   - no username, password or existence signal in the rows;
   - bounded volume under a flood;
   - an identical response and the same timing class for unknown and known users.

## 4. Characterization tests in this commit (today's behaviour, expected to flip)
`__tests__/security-http/canonical-login-security-characterization.test.ts` (built application, portOffset 29):
- S1: after logout, a copy of the logged-out cookie is still admitted (`/api/auth/me` 200 with the same identity).
- S2/S3: a failed canonical login and a logout leave the audit log without a corresponding row. A successful login writes exactly one `auth.canonical_login`.
- S5: the unknown-user and wrong-password responses are byte-identical (status and body) and set no cookie.
