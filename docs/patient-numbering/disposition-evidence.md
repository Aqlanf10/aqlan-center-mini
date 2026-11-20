# Private durable disposition seam (no installation)

A preview optionally registers only validated immutable enrollment, DB lineage,
owner actor, opaque request ID, and authoritative PostgreSQL-clock expiry.
There is no token, session binding, authorization fingerprint, requested start
number, or reason in this ledger. Exact committed receipts remain in the
existing atomic receipt/audit path; no extra copies of the old intent.

All optional operations share the existing owner revalidation and config
transaction. When configured, an injected managed-generation admission
callback must acquire the generation lock before config and return the
matching assigned XID from the same PostgreSQL client. The only implementation
demonstrated is the existing owned synthetic generation fixture, not an
operational fence or trusted production enrollment resolver. The transaction
verifies immutable enrollment continuity across reads. Database time and
conditional updates serialize open-to-committed and expired-to-retired.
Commit is the existing allocator transaction; applying, audit and receipt
failure rolls back the lifecycle state. Exact replay does not restart the
sequence, and old/foreign/untracked tickets do not get adopted.

Inspection reports only exact owner status, does not retire anything and
does not clear a missing receipt. Retirement is a separate explicit owner
operation, only effective after PostgreSQL expiry, not cancellation by
timeout or absence. Its tombstone rejects late submission. The UI/browser
journal is unchanged: no operation is mounted and no disposition is
auto-cleared. Retired status is not an API or cutover authorization.

Before release: the immutable owner enrollment/lineage resolver must lock
its canonical record on the same client, same-enrollment receipt read must
carry the approved rollover policy, and production-independent generation
admission still requires the operational DB fence against old/direct writers.
Reserve a reviewed numbered migration only after checking the real registry.
Extend independently witnessed full-archive recovery to include this ledger
and terminal tombstones, or refuse activation after backups lacking them.
Keep release on hold until a genuine authenticated browser flow, explicit
owner retirement UI and recovery/reconnection evidence are validated. No
live account, key, service, DB, backup, or migration was changed.

Retention must be governed before activation: preview issuance writes a
bounded row per successful distinct ticket, but this private candidate does
not schedule compaction or delete evidence needed for replay/retirement.

## Mandatory bound settings admission

The bound settings factory now requires approved expected schema/lineage/
generation, canonical signed-request admission, and a combined resolver
returning owner context plus immutable enrolled actor and lineage under lock.
It directly locks the PostgreSQL generation row FOR SHARE before the
allocator configuration and requires actual MANAGED state, exact version,
generation and lineage. Returning an XID or a claimed phase from a caller
is no longer accepted. The adapter independently checks the same client's
assigned transaction ID. Bound methods never fall into the abstract legacy
controller, and initial read/preview also refuse an absent ledger relation.
Independent NOWAIT probes in the local fixture confirm the real generation
and config locks are held while the owner is resolved. This is not proof
that an existing app credential has permission or that an old writer obeys.

The v1 archive/digest does not bind disposition-only differences: two
otherwise identical database snapshots can differ by a retired no-save
tombstone. No mounting, restore-to-cutover, publication or rollout is
authorized by these checks. Require apt storage/migration constraints,
independently witnessed archive coverage of the complete disposition ledger,
an actual protected owner resolver, a DB-enforced old-writer fence, and
authenticated browser validation before activation.
