# Canonical unit revision and location creation (unbound)

This batch extends only the private canonical reference lifecycle. The existing
item-only exports and legacy setup helpers remain available with their original
scope and behavior. New transaction-owning server-only entry points are
`commandCanonicalInventoryUnitRevise` and
`commandCanonicalInventoryLocationCreate`. Their matching lower transaction
facades accept only a genuine handle for their exact action. No route, issuer,
live grant, schema installation, rollout activation or production change is added.

A private closed map binds `item.create`, `unit.revise`, and `location.create` to
`inventory.items.create`, `inventory.units.revise`, and
`inventory.locations.create`, respectively. Each mutation requires
`inventory.references.view` as its prerequisite, not another mutation grant.
Non-owner administrators also need explicit grants; protected-owner semantics are
unchanged. The read seam projects only freshly proved actions. A read handle or
its preview is never mutation authority.

All modes preserve the original `reference.setup` journal, management=true, full
immutable intent digest, nonce, username hold and exact current generation. They
retain committed-admission XID enforcement, pending/committed/retired semantics,
exact replay, atomic auditing and rollback. The original key is shared across
actions, so an existing nonce cannot be repurposed for different content. Trigger
resolution uses the same validated authority schema and transaction-local path;
no guards are disabled. Authority locks precede the shared reset fence, then the
operation-key lock, then domain locks. Exact proof is refreshed after waits,
before every write and by the transaction-owning runtime before commit. Lower
facade callers must roll back every failure rather than catch and commit.

Unit revision locks the active inventory item `FOR UPDATE`, then checks the exact
latest version (zero only when none exists). Existing base unit and base precision
remain fixed. The existing `unitConversionSnapshot` validation constructs the next
immutable conversion version. Only that new version, audit and command result
are inserted: stock, prior versions, movements and document snapshots are never
rewritten. Concurrent revisions serialize on the item and stale contenders fail.

Location creation always uses the fixed clinic branch and existing bounded input
validation. Store/transit require a null doctor binding. Custody requires an
existing active doctor party, selected `FOR SHARE`, followed by renewed authority
proof. The lock protects that party through commit. No clinician identity,
patient access or commission authority is created. A plain INSERT means duplicate
location identifiers fail without overwriting or adopting existing locations.

Policy revision, suppliers, stock opening, routes and all activation work remain
outside this batch. Authorization policy version is 4; its document schema remains 1.
The canonical item-create suite retains its mutation assertions; only protected
owner read-preview expectations expand to the three supported actions.

## Bounded acceptance — 2026-10-27

All runs used frozen commit `835d082842d11b6f176c74b20a178eb1d36d0dba`,
tree `2e64e6717ce76e0a901d12d9ed326c3a4d915fcb`, with a clean tracked tree
before and after. Dependencies were an ordinary hardlink copy from the accepted
item-create worktree after byte-identical package-lock verification (no install
or symlink). Heavy jobs serialized through the shared acceptance lock. Node was
22.23.3 with a 4096 MiB heap limit; both PostgreSQL runs used newly initialized,
owned PostgreSQL 18.6 clusters, verified empty public schemas and clean shutdown.

- Full `tsc --noEmit --incremental false`: exit 0, no diagnostics.
- Focused central authorization/runtime units: 92/92 passed.
- Independent canonical unit/location PostgreSQL suite: 92/92 passed in
  `pg18-VQMyozDn`, system identifier `7701397020109226015`.
- Supported regression PostgreSQL suites: 185/185 across nine files in
  `pg18-cM6GIo5R`, system identifier `7701397121294536726`: canonical item-create
  (51), canonical reference-read (16), command lifecycle (17), reference setup
  (13), staff-operation runtime (22), procurement store (19), supplier finance
  (18), receipt adapter (23), and authority maintenance (6).
- Central owned-file lint and both domain files: exit 0 (domain run emitted only
  the Node experimental Undici proxy-agent warning).

Evidence is under `recovery-evidence-20261027/`: the two owned PG directories,
`canonical-units-locations-types.log`,
`canonical-units-locations-regressions.log`,
`canonical-units-locations-domain-lint.log`,
`units-locations-central-unit-retry.log`, and
`units-locations-central-lint.log`.

This is bounded source acceptance, not full inventory or deployment acceptance.
Known obsolete-issuer `inventory-supplier-operational` and
`inventory-authority-restore` suites remain unresolved outside this batch;
no assertions were inverted or tests skipped to hide those lanes. No live grant,
schema, issuer, route, activation or Production operation was performed.
