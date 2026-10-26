# Dormant procurement/custody browser recovery

Base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f`. This slice preserves the
existing private activation gate and does not register schema or enable a live
inventory flow. It extends the existing command transport; no financial writer,
role definition, salary/commission rule or server operation identity changes.

## Completed boundary

`useInventoryCommand(workspace)` snapshots the exact request synchronously,
assigns one operation key, hashes all serialized JSON values (including currency,
price, quantity, document and version) and commits an IndexedDB reservation before
any POST. Procurement/custody use a separate database and store from legacy direct
purchases. One unresolved command is allowed per browser origin, authenticated
user ID and workspace (`requests`, `administration`, `operations`, `custody`).
Username must also match the stored command. Recovery state contains the exact
operational payload, but never a session token/cookie or authentication authority.

The hook obtains the existing server identity from `/api/auth/me`, binds its
execution lifetime to the current session and sends the saved actor ID/name in a
versioned optional recovery protocol. The API authenticates as before, checks the
existing private gate, rejects a stale actor before dispatch and checks the exact
payload digest. Client-supplied identity never authenticates the operation. Each
store continues to revalidate live authority and enforce current policy.

Only successful committed operations and committed replays receive a matching
`recovery` acknowledgement, with actor ID, key and payload digest. The client also
requires the existing boolean `replayed` field. Generic success shapes, altered
acknowledgements, response decoding errors, timeouts, transport failures, 403/409,
missing schema and role changes cannot delete a saved command. Reload reads the
saved command and provides an explicit retry with the same body/key; there is no
automatic replay, replacement key or discard action.

Read/write IndexedDB transactions serialize tab reservations. Notifications carry
only `changed`; no payload or identity is broadcast. Focus rereads storage. A tab
with its own unresolved command cannot treat another tab's acknowledgement as
its outcome or clear that command after a later acknowledgement has superseded
it. It blocks pending a fresh review. Browser storage failure never falls back to
an unjournaled POST. A local invalid snapshot, or storage error followed by a
verified empty journal before any send, keeps the form editable.

All four workspaces show a read-only summary of the saved operation, including
its reference, quantity or line count, and reason when supplied. The summary does
not calculate stock, cost or payroll effects. Administration recovery is mounted
at page level so a committed request disappearing from the current selection does
not hide its retry. Custody replay confirmation uses neutral wording because the
old form's operation-specific success message is not durable.

## Explicit unfinished boundaries

- **Terminal rejection/retirement is not implemented.** The server's existing
  `inventory_operations` records only successes. Generic errors cannot distinguish
  a never-committed command from a previously committed one blocked by a later
  role/schema change. Therefore an already sent invalid/stale command remains
  locked, including an initial server refusal. A separately reviewed durable
  terminal-result/retirement protocol, under the same server key lock, is required
  to correct such commands safely. Do not erase browser storage or generate a new
  key to bypass the hold. This is an activation blocker, not complete recovery UX.
- **No authoritative realm identifier exists in this interface.** Current storage
  is isolated by browser origin and user ID/name, matching the current single
  clinic model. A future same-origin realm/database switch can reuse those IDs.
  Activation across that boundary requires a server-owned stable realm namespace
  in identity, request binding and storage, or a fail-closed migration policy.
  No inferred realm or permission-derived replacement key is created here.
- Persistence depends on the browser profile's IndexedDB. Browser-data deletion,
  lost devices and another browser/device are not recovered by this slice. The
  server journal still prevents a replay of the same preserved key; it does not
  deduplicate independent keys by similar contents.
- Recovery does not resolve invoice valuation, payable/reversal integration,
  clinical-use identity, material deduction policy, schema registration, master
  data or overall end-to-end inventory acceptance. All activation holds remain.

## Verification ownership

Focused tests in `inventory-command-recovery.test.ts`,
`inventory-command-recovery-route.test.ts` and
`use-inventory-command-headless.test.ts` exercise exact identity, actor binding,
existing API/gate compatibility, lost reply/reload, synchronous double click,
reservation failure, stale tabs, acknowledgement persistence failure and role
changes. The hook suite uses controlled lifecycle/storage adapters: it is not
real-browser/IndexedDB proof. Real IndexedDB multi-tab and built-app evidence must
be recorded separately by the composed acceptance run on its exact head.
