# Uninstalled managed-numbering checkpoint v2

V2 captures the exact canonical v1 allocator/audit/receipt/alias projection
plus the complete bounded disposition ledger and the actual managed generation
and lineage. PostgreSQL locks the expected, protected generation row in actual
MANAGED mode, then the existing allocator config row on the same client.
The ledger stores only immutable lineage, enrollment, actor, opaque request
ID, expiry and issued/committed/retired status. Time passing does not
singularly change an issued ledger row; explicit retirement does.

Strict validation requires complete one-to-one committed disposition ↔
receipt (exact global request ID and actor) ↔ existing revision/audit proof.
Issued or retired IDs cannot have a receipt, and unpaired legacy receipts
are not silently adopted. Missing tables, unexpected phase/generation,
invalid rows and oversized captures fail closed. The generation binds the
entire snapshot; ledger rows carry lineage and enrollment. This does not
permit managed-generation rollover within the same lineage, or migrate
old untracked requests/receipts into bound authority.

The bounded private TAR contains a canonical manifest, canonical v2 sidecar,
and an exact opaque attachment. Reconstruction rejects duplicate, aliased,
noncanonical, truncated or trailing container bytes. No attachment is
executed or construed as a validated product backup. SHA-256 of the exact
sidecar and exact containing TAR are checked against a separately delivered,
independently fenced custody record for the approved lineage and generation.
The archive manifest and the material used to calculate those hashes are not
a trusted current record. V1 can still be read for historical/legacy mirror
reconciliation but cannot enter the v2 managed admission path.

Witness: on owned PostgreSQL 18.6, capture one committed and one issued
request; expire the second request via database clock and explicitly retire
it without applying a numbering command. V1 bytes/digest remain equal;
V2 digest changes exclusively where the tombstone state changes. With an
independent-authority test double fixed to the latest v2 pair, earlier
pre-retirement snapshot and both combinations of stale sidecar/current
attachment and current sidecar/stale attachment are refused. The exact
latest pair is accepted as data and the existing DB owner service refuses
the late retired ticket. Removing the committed row causes v2 capture to
fail. No restore/reset was performed.

## Release gates still open

The actual full application tar.gz streaming path, DB/document-consistent
capture under a source writer fence, previous untracked history treatment,
canonical immutable owner and generation trust providers, migration registry,
independent real custody record, exact same-opened-bytes restoration,
staged re-projection (with tombstones), operational old-writer fencing and
authenticated browser acceptance remain required. The bounded private
attachment used in testing is deliberately synthetic, not proof that the
product archive carries this state or the runtime has the required grants.
Do not mount or enable managed numbering based on this local witness.
