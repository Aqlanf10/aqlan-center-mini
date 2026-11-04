# Prepared command admission and terminal retirement

This is a transaction-owned core and an unnumbered proposal. It adds no HTTP
dispatch, UI, browser-journal changes, automatic discard, replacement key or
interpretation of generic 403/409 errors. The existing private inventory gate
remains closed by default. No deployment, registered migration or activation is
part of this slice.

## Trusted identity and fresh admission

`principal.ts` is the common supplier/lifecycle seam. Its resolver is closed by
default and must be supplied by the canonical authenticated server adapter. The
validated immutable projection contains exactly realm ID, subject ID, numeric
actor ID and username. Mutable role/permission/version extras cannot change the
principal hash. Realm and subject cannot contain surrounding whitespace. Current
live actor status and role are still revalidated by the existing store policy.

The lifecycle factory receives a **server-owned** descriptor: a bounded ASCII
command namespace and the existing management/requester policy. Neither is a
client field or new permission grant. The policy is pinned in the immutable
admission binding and cannot be replaced by a weaker descriptor.

An explicit `admit` call records the exact original scope, actor, key and semantic
payload digest with realm/subject provenance and mandatory audit. It has no
business effect. PostgreSQL `created_xid` records the admission transaction;
execution and retirement refuse that same transaction. The central execution
helper enforces the same rule, so bypassing the lifecycle wrapper cannot execute
against an uncommitted admission. A successful admission must therefore commit
before execution or retirement.
`created_xid` enforces a different transaction, not authenticated provenance.
Imported/restored origin transaction IDs do not prove the current session or
realm; authoritative binding and restore lineage remain separate requirements.

**Absence is not provenance.** The server cannot prove that an arbitrary absent
legacy key was never sent merely because it has no result row. `admit` is prepared
only for new-protocol fresh intent established by a future trusted adapter; it
must never be exposed as a way to adopt an old unresolved browser command. There
is no user-supplied “fresh” boolean or implemented legacy adoption API. Existing
unbound committed results are explicitly refused by admission. Unbound absent
commands are refused by prepared execution/retirement. Future legacy adoption
requires independently established authoritative realm/subject/command lineage;
it cannot infer that lineage from reused IDs, a clinic label, current permissions
or a generic error. Existing HTTP recovery cannot invoke admission or clear its
saved command through this core.

## Execution and retirement share one durable decision

Admission, prepared execution and retirement use the **existing exact advisory
identity** `JSON.stringify([scope, actor.userId, operationKey])`, after live actor
authorization. The shared helper inspects bindings before returning a historical
success or invoking business work. An ordinary caller without the verified
principal cannot bypass a bound command, even if success already exists.

With a matching committed binding, lookup order is:

1. Existing successful operation: return the original result marked as replayed.
   Never turn it into a rejection or retirement.
2. Existing retirement: return the original immutable terminal acknowledgement.
   A later reason does not overwrite the original reason.
3. Admitted command with no outcome: execution may run its domain transaction;
   explicit retirement instead records a tombstone and mandatory audit atomically.

The same key with another payload conflicts. Realm, subject, actor or descriptor
policy mismatch refuses without deleting the binding. Retired commands cannot
execute. A domain failure rolls back its effects and result while the separately
committed admission remains recoverable. Retirement audit failure or caller
rollback removes the uncommitted tombstone. No ordinary failure is automatically
classified as terminal.

`execute` takes an **unjournaled transaction body**, not a full already-journaled
store method. It feeds one existing operation journal helper. Domain work retains
its existing validation and mandatory business-audit responsibilities. The core
snapshots and freezes the payload before asynchronous identity resolution and
passes that snapshot to domain work. Callers own BEGIN/COMMIT/ROLLBACK and must
roll back thrown failures; the core does not acquire connections or provision
schema.

The proposal adds append-only bindings and retirement evidence. Retirement has a
foreign key to its exact admitted digest. SQL guards acquire the same advisory
identity and prevent success/retirement coexistence or mismatched result hashes.
Both tables absent preserves unbound legacy behavior; partial proposal presence
fails closed. Prepared calls require the complete proposal. Existing supplier
commands only share the extracted principal resolver; they are not implicitly
admitted or made dependent on this new proposal.

## Transport and restoration limits

These acknowledgements are **not browser recovery protocol v1 acknowledgements**.
Their semantic payload digest is the existing domain operation digest, not the
v1 complete request-envelope digest. They have no v1 `recovery` receipt field.
A future transport must authenticate and bind the original complete envelope,
operation scope/key, semantic mapping, actor and realm, then deliver an exact
durable acknowledgement. Only a separately reviewed journal protocol may retire
browser storage; generic HTTP success/error shapes remain insufficient.

The authoritative realm adapter, fresh-intent admission transport, reviewed
legacy adoption, browser retirement UI, and restore/realm-transition protocol
remain absent. Restoring an older database snapshot is not proof that a previously
retired command is safe to run. These prepared-core tests do not establish
activation or cross-restore recovery readiness.

## Validation

Only synthetic PostgreSQL 18.6 in the disposable loopback test container was used.
Logs are `/workspace/inventory-resume-evidence/lifecycle-*`.

Initial lifecycle PostgreSQL run: 14 cases passed. Expanded tests cover committed
admission, direct-helper bypass refusal, absent and partial schema, explicit
rollback, stable principal projection, legacy refusal, lost replies, exact digest,
policy/realm/subject/actor mismatch, revoked actors, audit failure, both deterministic
race orders, and actual SQL-versus-JavaScript advisory-lock contention in both
directions. One test-only TypeScript nullable-spread issue was corrected by using
the validated common principal resolver.

The first composed run passed 75 of 76 cases. The existing procurement fixture
incorrectly asserted that every global workbench source was SAR despite valid
YER/USD supplier fixtures accumulated in the synthetic database. Its assertion
now requires its own exact source ID/count, quantity, amount and SAR currency;
the product behavior and existing doctor refusal/no-effects checks are unchanged.
The final composed rerun passed **4 PostgreSQL files / 76 cases**, including all
**17 lifecycle cases**, in 32.70 seconds. Supplier finance, procurement and custody
regressions were included. Focused recovery/route/hook, rollout and receipt-adapter
units passed **5 files / 51 cases**, 2.74 seconds. Final typecheck, changed-file lint
and `git diff --check` passed. No existing unit mocks needed modification.

No browser/build round was repeated: this slice intentionally exposes no new
transport or UI. Existing browser journal APIs and 403/409 retention are unchanged.
