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
outside this batch. Authorization policy version advances consistently while its
document schema remains unchanged. Acceptance evidence must be recorded after
independent real-PostgreSQL tests and the unchanged canonical item-create suite.
