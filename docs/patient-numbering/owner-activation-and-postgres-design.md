# Inactive owner account guard and PostgreSQL adapter plan

No binding, account, route, migration, sequence or live database changed. The new
`validateStaffAccountControl[Batch]` is a pure PRECHECK, not effective protection.
It reuses the existing private access state, binding validation and fingerprint.
It refuses mixed/unknown operations, stale authority, mismatched binding, generic
admin and changes to the bound owner through staff administration. Permission
changes still require validateStaffCapabilityChange and field validation. A valid
precheck never replaces transaction-time authenticated identity verification.

## Mutation-path inventory at base 97724c2 (static code review)

| Entry / underlying writer | Required future placement |
| --- | --- |
| app/api/users/[id]/route.ts PATCH -> db.updateUser (15500/15525) | Resolve complete patch operations before any write; transaction locks binding + fresh actor/target rows, checks versions/owner guard and last-admin invariant; update+audit atomically. No per-field partial commit. |
| Same route link-doctor -> db.linkUserDoctor (15309/15336) | Same authority locks, doctor party validation and audit in same transaction; no unguarded direct helper caller. |
| app/api/auth/password/route.ts POST -> updateUser | Separate self-service proof: verify current credential against locked current hash, check active/version, update+audit, issue new session only after commit. Current flow checks before update and swallows audit failure; it is NOT an acceptable owner-control reference. |
| app/api/users/route.ts POST -> user creation (db.ts ~3153) | Owner-controlled role/account creation; reject existing IDs/binding reassignment, atomic unique insert and audit. Creation must never establish owner implicitly. |
| app/api/auth/setup/route.ts -> initial admin insertion (~3103) | Setup must remain unable to rebind/replace an established owner; verify bootstrap state under lock. No token distribution or new setup activation in this candidate. |
| app/api/hr/staff/[id]/route.ts -> hr.setStaffUserLink (459) | Lock old/new users and staff record in deterministic ID order; protect bound owner identity on BOTH link and unlink endpoints. HR link is not itself authentication, but cannot be assumed harmless to identity mapping. |
| scripts/reset-password.mjs:183 | Out-of-band privileged maintenance must honor explicit owner recovery policy; an HTTP guard cannot constrain a direct DB credential writer. No script modification/execution here. |
| ensureSchema db.ts:1784 automatic doctor linkage; 2229 seed accounts; 2244 role normalization | Initialization/upgrade review must exclude unintended owner identity changes and prohibit default-account resurrection. Read-only routes calling ensureSchema are not a substitute for this review. |
| scripts/restore.mjs, scripts/restore-full.ts -> lib/restore/*; migration/provisioning paths | Restore/import can replace users, binding or counter history wholesale. Activation requires verified lineage, binding/version reconciliation and session revocation before serving requests. |

Search covered app/lib/scripts/migrations for users writes, password_hash,
hashPassword, updateUser/linkUserDoctor/setStaffUserLink. This is a reviewed source
inventory, not proof that arbitrary external DB operators or dynamic SQL cannot
write accounts. Raw DB access remains an external trust boundary.

Bulk: acquire binding lock, lock actor and every distinct target in sorted ID
order, freshly resolve all, preflight entire batch and all domain validations,
then perform changes/audits in one transaction. Any unknown field, stale version,
protected target, duplicate/conflicting target or audit failure aborts the batch.
The pure batch helper does not acquire locks or execute this transaction.

## PostgreSQL adapter design (not implemented or executed)

- Separate auth from allocation. Adapter receives an already authenticated subject
  reference but reloads account state and trusted binding under lock. Never accept
  isOwner/userId/binding from request JSON. No environment-based emergency bypass.
- Maintain global active-prefix configuration + revision, prefix history/provenance,
  and durable actor+request-id command receipts. Keep sequences for each allowed
  letter from a fixed allowlist; identifiers are never interpolated from raw input.
  Using PostgreSQL sequences preserves consumed allocations after rollback; a plain
  transactional counter alone would not preserve current rollback semantics.
- One declared advisory lock order shared by startup, configuration, allocation,
  import/walk-in/booking and reset. Lock global config and target prefix before
  preview/change. PostgreSQL nextval is atomic but does not alone fence config.
- Import P last_value/is_called once with a proven migration checkpoint. Never
  lower P or overwrite its pending value. Existing P default/floor behavior remains
  unchanged until an explicit reviewed configuration transition. A fresh prefix
  needs complete stored-ID reconciliation, not simply no current patients.
- On configuration: lock, reauthorize, look up idempotency receipt, compare global
  and prefix revisions, validate plan, transactional ALTER SEQUENCE RESTART (not
  setval), update active prefix and revision, audit + receipt, commit. Any exception
  rolls back configuration. Replays still require fresh authority before response.
- On allocation: read locked active prefix, nextval exactly once, format minimum
  five digits without truncation. All four db.ts allocators must use it. Preserve
  UNIQUE(patient_number), never rewrite old identifiers. Do not expose raw SQL as
  an endpoint. Update P-only privacy redaction before activating another prefix.
- History tables/config/receipts/sequences belong to backup and retained reset
  policy. Update schema ownership/contracts and full table classification tests.
- Restoring an old snapshot cannot prove no numbers were issued after that snapshot.
  Require a surviving trusted high-water checkpoint or a reconciled newer backup;
  otherwise fail closed on configuration/issuance until reviewed recovery. Never
  silently call an old restored prefix fresh. This is a separate acceptance gate.
- Required real PG18 tests: two configuration requests; change vs every allocation
  path; idempotent replay and conflict; audit/commit failure; restart before first
  allocation; old/new snapshot recovery; legacy weird IDs; pending sequence; return
  to used prefix; rolled-back allocation; exhaust/max digits; reset retains state.

## Binding and recovery options for later review

Preferred engineering direction: a dedicated versioned owner binding outside all
staff-editable tables/API permissions, with explicit enrollment and no automatic
first-admin/name inference. Its store/access model and recovery trust root need
separate review, not a generic settings field. An external protected identity
provider is an alternative if already established; do not introduce one implicitly.

Whichever is chosen must cover non-owner password resets, owner credential/session
revocation, staff account role/link edits, backup restore and direct maintenance.
Protecting users.id without those controls leaves account takeover possible.
Recovery should be a separately authenticated, audited, limited workflow that
revokes old sessions and increments binding version; not an undocumented setup
secret, blanket admin permission or permanently active bypass. No actual enrollment,
owner transfer, recovery credential or identity-provider configuration is performed.

Next safe code: synthetic transaction adapter tests for sorted locks and full-batch
abort, plus a DB18-only allocator prototype in an owned disposable test database.
Do not wire live API/UI while owner protection and restore fencing remain unproved.
