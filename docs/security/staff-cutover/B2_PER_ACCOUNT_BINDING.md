# B2: account creation in a ready identity with a per-account binding revision (M4 design)

Status: **design + isolated tests** (review 6507696166 item 3). There is no schema change, no runtime
wiring and no activation. The pure model in `lib/staff-claims-v3-design.ts` is imported by no
runtime module (the test enforces this). Its rules are pinned by `__tests__/staff-claims-v3-design.test.ts`.

## 1. Why (from CANONICAL_ACCOUNT_WRITES.md F1/F2)
- In `ready`, no account can be bound (the runtime schema guard refuses identity mutation).
- Every durable session signs the **global** `registryRevision`, so any binding would invalidate every session in the clinic.

## 2. Claims v3
- **Keep every v2 anchor:**
  - realm, subject, generation;
  - control epoch, account epoch, credential version;
  - permission revision, provider tuple.
- The global `registryRevision` claim is replaced by the account's own **`boundRegistryRevision`**: the `registry_revision` of that account's current binding event, `staff_identity_current.bound_registry_revision`.
  - The global revision is still proved for the history integrity check, but it is never compared to a claim.
  - Binding another account moves the global revision and leaves this session intact.
  - Rebinding this account moves its own bound revision, and its sessions refuse with `BINDING_STALE`.
- The issuer captures `boundRegistryRevision` under the shared fence, in the same proof as the other anchors.

## 3. Ready-state creation (`staff.accounts.create`)
One authority-writer transaction:
1. EXCLUSIVE fence first.
2. Fresh actor proof with `staff.accounts.create`, within the actor's own authority.
3. Insert the user:
   - `authorization_mode='canonical'`, active;
   - the creator-supplied initial credential (hashed);
   - **document = `initialReadyStateDocument()`**: `pending`, revision 1, no grants, both scopes `none`. It resolves to nothing until the owner's editor save confirms it.
4. Append one subject and one binding event for **this never-bound user only**, with CAS on `registry_revision`. Generation, realm, owner subject and control epoch stay immutable.
5. The audit row `staff.account.create`, in the same transaction.

Effects:
- **No other session is revoked:** their bound revisions did not change.
- **Nothing is orphaned:** the subject, binding event, user and audit row commit together or not at all.
- A failed transaction leaves no subject without a user, and no audit row without both.

## 4. Lifecycle rules (`readyStateIdentityEffect`)

| Change | Binding | Account epoch |
|---|---|---|
| create | appends one binding (new user only) | unchanged (new row) |
| disable / enable | **never retired** | incremented (0076), so the account's sessions fall |
| rebind (reviewed recovery of the same person) | appends; the old subject is superseded | incremented |

A binding is never retired by disabling, so re-enabling keeps the same subject and history.

## 5. Coordinated transition (`CLAIMS_PHASES`)

| Phase | Issue | Accept |
|---|---|---|
| v2-only (today) | v2 | v2 |
| dual | v3 | v2, v3 |
| v3-only | v3 | v3 |

- Moves are one step at a time (`claimsTransitionAllowed`).
- v2 is refused **only** in `v3-only`, which is entered after every instance runs `dual` and the longest v2 session lifetime has elapsed.
- **Rollback:**
  - `v3-only → dual` strands nothing;
  - `dual → v2-only` strands only v3 sessions, which fail closed and re-login;
  - nothing is silently accepted in either direction.
- The rehearsal (M4) runs both rollbacks on a synthetic database with live sessions of each version.

## 6. Schema (M4, not in this commit)
- `staff_identity_current.bound_registry_revision` already exists. No new identity column is needed.
- The ready-state lifecycle in the runtime schema guard: append-only binding of a never-bound user under CAS.
- One migration from our reserved range (0083–0086), registered with the M4 upgrade, restore and rollback rehearsal. Never 0087, 0088–0089 (Dot's) or 0090.
- Logout revocation (`LOGIN_SESSION_SECURITY.md`) adds `sessionId` in the same claims v3 transition.
