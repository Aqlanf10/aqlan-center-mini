# Local phase 2 — incomplete, not a release candidate

Base remains PR343 / `5910878f6807df5ff621ac03e1883dd8483c2ac4`.
Per the parent instruction, none of this phase has been committed or pushed.
The parent authorized 0063 after checking all 360 fetched remote branch heads;
no 0063 file conflict was found. HR 0062 and PR342 were not used.

Implemented locally:

- Additive migration 0063 and byte-identical runtime SQL, registered with the
  standard migration lock/checksum mechanism. Repeated initialization does not
  reinstall the old 0061 same-currency guard over the successor.
- Append-only document and per-receipt event tables, YER -> SAR only. Every
  historical receipt in the authoritative source lineage requires an event.
  Each event proves its original payment row, recorded SAR amount, historical
  YER base amount and recorded FX arithmetic. It is not a cash entry.
- Automatic negative event for a refund of an already reclassified receipt.
  Ordinary receipts cannot newly target the retired YER lineage. Receipt
  correction replacement routing is still outstanding.
- Independent read adapter verifies document ownership, full coverage,
  disjoint lineages, exact stored payment snapshots and recorded amounts.
  This adapter is not yet consumed by the operational settlement readers.
- Reset table ordering includes both new evidence tables.

Validation on disposable local PostgreSQL 18.6 at localhost:55433:

- `invoice-currency-schema.test.ts`: 12 passing tests. Synthetic 700/100/100 SAR
  receipts prove 369000 YER -> 90000 SAR minor; the independent 100 YER payment
  stays outside the evidence. Original receipt rows remain identical. A 50 SAR
  refund appends one negative event. Missing evidence, duplicate allocation,
  destructive writes, imported snapshot/ownership/coverage corruption and a
  new ordinary receipt to the retired source are rejected.
- Existing `invoice-settlement-position.test.ts`: 13 passing tests.
- Typecheck and targeted ESLint pass.
- Logs: `/tmp/currency-phase2-pg.log`, `/tmp/currency-phase2-typecheck.log`,
  `/tmp/currency-phase2-lint.log`.

Not completed: operational currency writer/preview, exclusive plan coverage,
paid/locked commission policy, receipt-correction replacement targeting,
settlement/debt/account/checkout/portal/print/report/commission projections,
noncash GL entries and dated history, backup/restore schema contracts, and
full regression/concurrency/HTTP Arabic evidence for the complete feature.
The schema tests deliberately use low-level synthetic fixtures; they do not
prove the real API/UI workflow. The original API still rejects a currency field.
Do not present the user's partially-paid scenario as fixed yet.

Coordination: `lib/reports.ts` is reserved to the parent's separate report cutoff
repair. No edits were made there. Integrating settlement allocations needs an
agreed handoff to that reader. Do not push this partial phase into PR343 while
the parent is reviewing the smaller fixes. No production data was accessed or
modified and stopped staging was not started.
