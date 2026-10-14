# Invoice installment namespace and ownership

Root allocated `0059_invoice_debt_installments.sql` exclusively to the invoice/opening-debt schedule slice on 2026-10-12, after checking main, all ten open PRs and relevant HR/installment branches for collisions.

This branch is based on PR326 `03d325a8b6511098237458c38444620db59709e7`, which contains migrations 0001–0043. The gap 0044–0058 is intentional. Preserve reserved 0052–0055 Ortho and 0056–0058 HR; do not import their content, invent gap migrations, or rewrite applied files. The numbered runner sorts actual files and supports these gaps. The ownership harness explicitly lists the reviewed branch chain through 0043 plus 0059.

0059 adds immutable schedule references and versioned dated terms against existing invoice/opening debt. It creates no invoice, receipt, ledger principal, cash entry, historical collection or clinical completion. Full-payment terms do not mean a paid receipt. Installment dates/amounts are stored together under a database exact-sum check.

Invoice work owns PatientLedger, invoice input/price/linkage modules, new debt-repayment modules and routes, focused tests, and 0059/bootstrap/schema-contract/reset classification. Reception checkout/queue/notifications, shared CollectPaymentModal, HR/Ceph/AI remain outside this slice. The only planned `lib/db.ts` changes are schema bootstrap and a narrow transaction-owned existing-payment adapter; no checkout helper is being rewritten.

Frozen pre-schema pricing checkpoint: `/workspace/reviews/invoice-workspace/invoice-workspace-checkpoint.patch`, SHA256 `8fa7e3ca46edb280095a727cde9367c51245abbb47a9c2fd6a48c66702fab162`. It has 399 related unit/rendering checks, 81 focused PG checks and 60 passing HTTP checks; two HTTP assertions honestly fail for still-missing installment controls. It is a review checkpoint, not a completed release.

Backup discovers tables and dependency order from PostgreSQL metadata. The new revision table additionally requires ordered export by arrangement/version because its INSERT guard enforces consecutive versions; this is one narrow addition in the existing backup SELECT. New tables must be proven in an actual isolated backup/restore round trip together with prior invoice data, and explicitly belong to the reset wipe classification. Storage/collection/UI verification is pending until implemented; the earlier pricing checkpoint does not prove it.

## Historical documents reservation —0060

Root formally allocated `0060_historical_treatment_documents.sql` exclusively to this invoice/historical multi-line slice at2026-10-12 after fresh21:38UTC read-only checks of main and all10open PR inventories. Preserve0052–0055Ortho,0056–0058HR and0059invoice installments. The shipped branch chain is0001–0043,0059,0060; the gaps remain intentional. No existing migration is rewritten.

0060adds immutable document headers and financial revisions, and document identity columns on legacy treatment agreements. Existing standalone rows retain mandatory paid/remaining arithmetic. Document-backed lines have NULL paid/remaining fields; the aggregate is stored once on the document revision. The same byte-identical SQL is loaded by the numbered runner and development bootstrap. Corrections append versions and use canonical opening and repayment writers.

Backup discovers FK order and additionally exports historical revisions after agreements/coverage snapshots, ordered by document/version, because the insertion guard validates complete immutable clinical evidence. Both new tables belong to the reset wipe classification. An actual synthetic migration/backup/restore test is required before integration.

## Correction lineage —0061

The coordinator explicitly extended this worker's scope to complete ordinary/historical corrections and uncertainty recovery on 2026-10-14. A fresh read-only inventory of all 13 open PRs at 01:55 UTC found no 0061 migration; main and the current local chain also lack it. This branch now uses `0061_invoice_correction_lineage.sql` for immutable original→replacement invoice references and approved line snapshots. Integration must preserve existing reservations 0052–0058 and this 0061 namespace. Inventory evidence is `/workspace/reviews/invoice-workspace/migration-inventory-20261014.json`.

These references do not create payments or move existing receipts. They permit the canonical debt reader to count original receipts against the current replacement without counting them twice, and preserve the exact correction acknowledgement for retries. Migration/bootstrap/schema/backup/reset acceptance remains pending while this slice is implemented.
