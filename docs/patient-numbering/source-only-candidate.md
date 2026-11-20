# Owner-selected patient file numbering: source-only foundation

Base: 97724c2ef6d0a85819648111d2fa617445943d62. No route, UI, SQL, migration,
Railway changes, reset, or production behavior is activated by this patch.
7000 is an example, not the desired future minimum. The existing bootstrap still
contains its old floor until a complete transactional implementation is approved.

## Implemented and verified

`lib/patient-numbering-policy.ts` provides strict single A-Z letter normalization,
positive decimal validation without floating-point rounding, exact padded preview,
prefix-scoped high-water/pending-number checks, stale-preview rejection, and
fail-closed history completeness. Numbers are capped at 18 digits to retain the
existing portal's 20-character identifier limit. Existing larger historical IDs
must remain unchanged; unsupported historical maxima must block reconfiguration.

25 new synthetic unit tests passed; 112 total tests passed across the new policy,
existing staff-capabilities, and document-numbers suites. Targeted ESLint and
git diff --check passed. Full tsc --noEmit --incremental false was attempted but
failed with JavaScript heap out of memory at approximately 2 GB (exit 134);
this is not a typecheck pass.
Runtime used Node 24.22.3, not the project's required Node 22. No PostgreSQL,
HTTP, Playwright, full build, or real concurrency success is claimed. The stale
revision test is a pure policy test, NOT proof of a database lock implementation.

## Security dependency: do not substitute admin for owner

At this base, `lib/staff-capabilities.ts:28-40` and
`docs/security/scoped-staff-capability-foundation.md:65-79` explicitly describe
trusted owner binding as a FUTURE bootstrap with no production caller.
`ownerContextFromTrustedBinding` is only used by tests. The legacy adapter cannot
infer owner. `lib/staff-authority-snapshot.ts` is a preparatory read-only adapter,
not authentication, and canonical accounts remain quarantined. Existing generic
settings category authorization therefore cannot safely implement this feature.
Required dependency: a separately reviewed server-only owner-binding lifecycle,
backed by immutable user ID and version outside staff-editable data, connected to
fresh authenticated identity and revocation. Do NOT infer first admin, username,
role, client JSON, setup token, or silently activate AP/canonical authorization.
No environment setting or permission expansion is added by this patch.

## Transactional integration still required

1. Establish the owner dependency above. Preview is not authorization. POST must
   authenticate again and load the trusted owner binding and fresh account state.
2. Use durable prefix-specific allocation history, including retired allocations.
   P must inherit current patient_number_seq last_value/is_called without lowering
   it. A never-used prefix may begin low ONLY after complete historical review.
   Preserve all existing patient_number values and UNIQUE constraint.
3. Stored canonical `A-00037` is history for A even if no counter exists. An imported
   external identifier inside note metadata is NOT allocator history. Ambiguous
   stored identifiers (including noncanonical P-37, lowercase, extra zeroes or
   digit-bearing legacy prefixes) require reconciliation; null parse does NOT
   prove a prefix is fresh. Never strip digits from all prefixes and mix counters.
4. Remove unconditional 7000 floor only with verified bootstrap/upgrade logic.
   Ordinary startup must not overwrite owner configuration or consume a pending
   value. No selected configuration means retain legacy current allocation;
   a fresh installation needs an explicit reviewed default, not automatic 7000.
5. Route every allocator through the same locked implementation: db.ts creation
   paths at base lines 2941, 3618, 3702, 5170, import, walk-in, booking, schema
   initialization and restore. Audit and configuration must be atomic. setval is
   not transaction-rollback safe. Preserve consumed-number behavior after rollback.
6. Durable operation idempotency must return the same result on retry, while stale
   different commands fail. Review lock ordering against patient_import/reset.
7. Update privacy masking in lib/ai-tools/privacy.ts (currently P/p only) BEFORE
   enabling other prefixes, plus portal/search/printing/export/import consumers.
   Keep historical P identifiers redacted after switching to another prefix.
8. Add migration and schema ownership/contract proofs. Do not append unknown tables
   blindly: clinic-reset exhaustively classifies tables. Allocation history is
   retained, never wiped by reset. Existing protected agreement-history refusal
   stays intact. No live reset or schema/drop/reseed is part of this work.

## Required acceptance matrix before any deployment

- Real PostgreSQL 18 synthetic concurrency: ordinary/import/walk-in/booking versus
  configuration; two owners/configuration tabs; repeated idempotency keys.
- Rollback/crash/restart and first cold bootstrap before/after configuration.
- Existing high P history, missing/deleted patient rows, pending is_called=false,
  historical canonical A before counter creation, new B, return to used A.
- AP/legacy owner boundary, inactive/revoked identity, forged owner flag, generic
  admin, direct API bypass, stale preview; audit failure must fail closed.
- All-prefix privacy masking; portal/search/print compatibility; existing financial
  and patient links unchanged; UI close/cancel/double-submit.
- Full build, unit, PostgreSQL, HTTP, Playwright and schema gates on Node 22.

This candidate deliberately does not expose a nonfunctional owner button, silently
broaden privileges, or present a source-only policy as a working feature.

## Continuation: inert transactional application service

`lib/patient-numbering-command.ts` implements command validation, opaque canonical
owner checks (WeakMap-backed fingerprint, not JSON/admin role), fresh authority
before idempotent replay, prefix planning, conflicting-key/stale-preview rejection,
and atomic adapter contract for configuration plus audit plus operation receipt.
A missing adapter always denies. No production adapter is registered. No route or
button is exposed, so this cannot be confused with an activated settings feature.

The synthetic in-memory serial adapter tests concurrent identical/different
commands, one audit, retry conflict, forged owner/admin denial, revocation before
replay, and audit failure. These are orchestration tests, not PostgreSQL isolation
or rollback proofs. The future DB adapter must still prove the documented locks,
actual durable transactions, allocation high-water and restart/restore contracts.

Additional mandatory release blocker: immutable owner users.id alone is insufficient
while legacy generic-admin account APIs can reset the bound owner's password or
change account authority. Protect owner account controls first, and check current
active/credential/permission/binding versions inside the transaction. The synthetic
owner used by tests cannot be a production bootstrap. No actual identity is bound.

Continuation verification: 120 tests passed in four focused suites (8 command,
25 policy, plus existing capability and document-number tests). Targeted ESLint and
strict TypeScript check of command and imported policy/capability modules passed.
Full-project typecheck/build/PostgreSQL/HTTP/Playwright remain unverified. The
previous full-project heap-limit failure is not superseded by the targeted check.
