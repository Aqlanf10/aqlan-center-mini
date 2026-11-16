# Reversible invoice archive: bounded implementation design

Base: `dc1be92eb17b4714d02caa32f9b6e3f848016a4f` on independent branch `codex/invoice-archive-add-service`.

## Existing contract and gap

- `Invoice.status` is only `open | paid | cancelled` (`lib/db.ts`). `setInvoiceStatus` cancellation changes posted debt, releases plan financial acceptance and reopens orthodontic billing decisions. This is not archive and must not be reused.
- `listPatientInvoices`, `getInvoice`, `patientLedger`, `debtAccountDue` and print readers retain invoice identity. `currentStatementInvoices` excludes cancelled documents only. Archive must never enter these debt or statement filters.
- `readInvoiceSettlementPosition` resolves actual receipts through the immutable correction lineage. The manual `paid` status is not settlement proof.
- No policy allowing unpaid/partly paid/ambiguous invoices to be archived was found. Such attempts return `policy_decision_required`, without a write. Restore remains available even if a later refund creates debt.
- Current authorization uses roles plus current-session revalidation. Archive/restore use the existing admin boundary, and archive reads retain finance-reader authorization and require the existing patient-ledger read grant for cashier/accountant because previews include actual settlement. No new scoped-role policy is invented.

## Implementation decision

An independent append-only `invoice_archive_events` table stores only documentary state, monotonically increasing version, reason, actor, request identity and timestamp. It never updates invoices, items, receipts, plans, visits, signatures, lab rows, commissions or financial schedules. A separate archive listing selects documentary state; accounting/statement readers remain complete.

The table is proposed only in `migrations/proposals/invoice-archive.sql`: no numbered migration, automatic runtime DDL, schema-manifest registration or production adoption. Numbers 0073–0080 remain untouched. Readers report `migration_pending` and writes fail closed until the exact reviewed proposal has been explicitly adopted. Runtime readiness checks table shape and append-only/ownership trigger identity, rather than table existence alone.

Within a transaction: revalidate current admin; serialize request identity; lock patient then invoice; recover exact prior request (same actor/body) before stale-version and period checks; reject changed reuse; then compare version, check current locked period and actual invoice settlement. A transition and its audit event commit together. Same-state archive is a no-op with no event/audit. Replaying an old archive after restore returns the original acknowledgement plus separate current state, never rearchives. A new archive after restore requires current version and new key.

## API

- `GET /api/invoices/[id]/archive`: current documentary state, readiness and archive eligibility.
- `POST /api/invoices/[id]/archive`: `{action: 'archive'|'restore', reason, idempotencyKey, expectedVersion}`. Response contains `receipt`, `current`, `replayed`, `noop`.
- `GET /api/invoices/archive?patientId=…`: all documentary metadata and archived documents for the given patient, never used as an account/statement replacement.

A locked original invoice period conservatively refuses new archive/restore transitions. Exact committed replay remains readable. No final deletion route exists.

## Required evidence

Synthetic unit and real PostgreSQL tests cover strict parsing, unpaid/manual-paid refusal, paid/zero invoices, no-op and replay, lost acknowledgement, same-key concurrency, stale conflicting operations, archive→restore→archive, restored debt after refund, immutable financial rows and account balances, preserved current statement/print document, revoked/non-admin authority, closed periods, append-only/ownership SQL guards, readiness failure and migration rerun. Existing clinical/source/commission fixtures are fingerprinted before and after where available. No real records or external messages are used.
