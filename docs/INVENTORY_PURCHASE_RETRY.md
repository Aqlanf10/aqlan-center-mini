# Durable stock purchase commands

## Scope and wire contract

This protects the existing item-detail form's non-return `in` purchases, including
stock-only receipts. It does not activate procurement or change returns,
clinical outflows, unpriced item-creation opening stock, currencies or payments.

The existing `POST /api/inventory/{id}/movements` accepts:

- `Idempotency-Key`: a UUID, normalized to lowercase by the server.
- `X-Purchase-Actor`: URI-encoded expected username.
- `X-Purchase-Actor-Id`: expected numeric user ID from the existing `/api/auth/me`.
- JSON `{ "protocol": "inventory-purchase-v1", "purchase": { ... } }`.

The actor headers are expectations only, never authentication. The signed,
currently valid session supplies the durable actor ID. No top-level `kind` is
permitted in the envelope. The released pre-protocol handler therefore refuses
it before writes; there is no unkeyed fallback. New servers reject old flat
financial purchases (supplier or explicit unit price) with a reload requirement.
Unrelated legacy callers retain their existing contract.

Fingerprint v1 is SHA-256 over canonical JSON containing operation, version,
route item ID and the exact parsed original purchase document. Object keys sort;
field presence, scalar types, values and array ordering do not normalize.
Authenticated user ID binds the receipt separately. Neither client actor nor
normalized price/quantity is a substitute for identity.

## Transaction and terminal outcomes

One transaction acquires the shared reset fence, revalidates the admitted
session with the existing held user lock, locks the request key, and checks its
receipt before mutable item/supplier validation. An identical command replays
the original snapshot. A different actor or fingerprint receives a conflict
without receipt disclosure.

For a new valid command, stock, optional payable, mandatory purchase audit and
receipt commit together. Any unexpected failure rolls all of them back.
Different keys represent intentionally different purchases.

Controlled validation/business refusals become immutable `rejected` receipts
under the same key lock. This is necessary: absence from a lookup alone cannot
prove that an earlier request still in transit will not commit later. After a
terminal rejection, every delayed same-key command repeats that rejection,
even if item/supplier eligibility later changes. Correction requires a new key,
and is safe only after the matching terminal receipt is acknowledged.

Both committed and rejected keys are permanent. There is no expiration,
cleanup, backfill, key reuse or historical purchase rewrite.

The versioned acknowledgment binds key, digest, item and numeric actor:

- `status: committed`: original movement ID, original balance, replay flag,
  payable-created boolean, and original result projected through current
  movement visibility rules. Reception does not receive admin cost/payable IDs.
- `status: rejected`: replay flag and safe controlled refusal text. No movement,
  payable or result fields.

Authentication errors, conflicts, generic errors, redirects and malformed
responses are not terminal acknowledgments and cannot clear uncertainty.

## Browser recovery

A purchase-specific IndexedDB journal persists the exact envelope, key, digest
and actor/item scope before the network request and waits for transaction
completion. The numeric user ID is read from the existing authenticated profile,
not invented from a patient or supplied as authority.

One synchronous in-flight guard, transactional reservation and durable revision
tombstones coordinate repeated clicks and tabs. An unresolved command freezes
its form. Reload and explicit retry reuse its exact body and key. Storage failure
prevents a new submission. A matching committed or terminal-rejected
acknowledgment retires the payload while retaining a tombstone. A failed refresh
after acknowledgment does not revive the purchase.

Observed session changes invalidate execution generations. A stale tab cannot
send the old principal's purchase as a different logged-in user because both
expectation headers are checked server-side.

## Necessary empty-demo-reset compatibility

`inventory_purchase_receipts` is classified KEEP, never an unconditional wipe
target. Reset acquires the exclusive counterpart of the purchase fence before
any table lock, then holds an EXCLUSIVE receipt-table lock. Any existing outcome
causes a protected-history refusal before backup or wipe.

When the receipt table is genuinely empty, the existing separate backup
connection remains able to read it. The final single TRUNCATE includes the
proven-empty table only to satisfy its movement foreign key. Its trigger
rechecks emptiness under TRUNCATE's ACCESS EXCLUSIVE lock. UPDATE and DELETE
always fail. No receipt key can be removed.

Inventory items, users and suppliers remain retained, and their identities are
not restarted or repopulated. A delayed never-committed purchase that waits
behind an empty reset therefore still targets the same item.

## Migration and release gate

Migration `0065_inventory_purchase_receipts.sql` and the runtime SQL constant
must be byte-identical. The existing checksum-checked, advisory-locked runtime
migration mechanism applies the additive table/constraints/guards. There is no
new migration application route. A name/table collision or registry checksum
mismatch fails closed.

The migration CLI's Production/unknown-remote `--apply` restriction remains
unchanged and must not be bypassed. Production migration execution is not part
of the local verification. The release owner must establish actual supported,
authorized access and confirm that the existing normal deployment/runtime path
is allowed before release.

Health/Online status alone does not prove migration application. The existing
packaged read-only preflight is documented in `DATABASE_MIGRATIONS.md`:

1. On a verified actual MINI web-service executor, inspect
   `node /app/preflight/runner/run.mjs --help` (connection-free).
2. When authorized, use the existing connection environment with
   `DATABASE_ENVIRONMENT=production node /app/preflight/runner/run.mjs`.
3. Retain the report provenance for the exact released artifact and verify 0065
   is not missing and has no checksum/name mismatch. Legacy runtime-unregistered
   versions can leave the overall registry comparison false; do not conceal
   those separately disclosed findings.

This identifies the supported command, not evidence that an execution route is
available in the current session. If verified access is unavailable, live
migration verification remains an explicit release gate.

On application rollback, retain the table and every outcome. New envelopes
fail closed on the old server, but old clients plus old server still have the
legacy duplication risk. A supported rollback must retain the protocol
protection or quiesce purchases; never fall back to unkeyed submission.

## Narrow response-normalization changes

New movement INSERT results project `expiry_date::text` to preserve PostgreSQL
DATE semantics in every server timezone. Stored dates and historical read paths
are unchanged. Purchase reasons retain the existing trim/300-UTF-16-unit limit,
with shared UTF-8 normalization so a split/lone surrogate cannot cause a
permanent mismatch between a committed receipt and browser acknowledgment.
The raw request fingerprint remains unchanged by either normalization.
