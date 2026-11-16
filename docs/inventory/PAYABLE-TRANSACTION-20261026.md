# Native payable transaction primitive — integration remains dormant

Baseline: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f`.

`createPayableInTransaction(client, input)` extracts the existing payable insert
and returned projection onto the caller's connection. A savepoint probe refuses
autocommit before any business query; only PostgreSQL `25P01` becomes
`transaction_required`. Other errors propagate unchanged. A caller's existing
same-name savepoint survives the probe. The primitive never acquires a connection,
initializes schema, begins/commits/rolls back, releases a connection or retries.
The caller must roll back after every thrown failure.

The existing `createPayable(input)` API now owns one transaction around both
insert and read. A failed final read can no longer leave a committed debt behind.
Its input, returned projection, native amount/currency, supplied exchange-rate
snapshot, base conversion and existing lab-order conflict result (`null`) remain
the same. A lab-order duplicate is still deduplicated by the existing unique
constraint. Equal ordinary supplier invoices remain distinct writes; this helper
does not invent supplier invoice identity or a retry policy.

This is a persistence primitive, not an authorization or approval boundary. Its
caller must validate the trusted input and live actor, lock and validate the
supplier/source documents in the relevant order, establish the invoice's immutable
source link, insert mandatory audit, and save the command result in the same
transaction. Existing callers continue to own their own validation. The helper
does not create stock, expenses, payments, commission or payroll entries.

The focused PostgreSQL test composes the primitive with the existing throwing
`insertAuditRow`, demonstrating that an audit error rolls back debt and unrelated
caller work. It also tests failures after the debt insert and final read, caller
rollback/savepoints, YER/SAR/USD snapshots, concurrent lab-order conflicts and
ordinary-invoice non-deduplication. Unit cases verify that probe errors and
release failures never proceed to a business query. Test results are recorded in
the containing continuation handoff; the presence of these tests is not a pass
claim.

No invoice approval command is connected by this change. Invoice revision,
approval, one-invoice/one-debt linkage, durable command recovery, invoice
cancellation/credit and financial source-linked stock return still need a complete
reviewed lifecycle. Supplier payment and payment-void guards remain owned by the
existing finance writers. An opening-balance correction is not a supplier credit.

The manual `/api/payables` route still audits after its call through the existing
best-effort `recordAudit`; that separate legacy gap is not repaired here. The new
transaction primitive makes an atomic caller possible without asserting that all
current payable routes already have atomic audit or idempotency. No inventory
flag, migration registration, payroll policy, deployment or live data changed.
