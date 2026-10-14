# Coordinated schema reservation request

No migration number has been selected or registered. Root controls serial integration after invoice, HR and Ortho/Ceph acceptance. These SQL modules are proposals explicitly applied in synthetic PostgreSQL fixtures only. Runtime fails closed with `schema_not_ready` until a reviewed migration exists.

The fresh branch-file/blob inventory is `migration-ownership-snapshot-20261014.json`. Main and feat/invoice-entry-main contain 0001–0043. feat/unified-invoice-agreement-entry, feat/hr-staff-tasks-phase1 and feat/ortho-case-study-completion additionally contain 0045_hr_staff, 0046_hr_tasks, 0047_ceph_correction_lineage, 0048_hr_contracts_attendance_leaves, 0049_hr_payroll_disbursements, 0050_hr_payroll_integrity and 0051_ortho_treatment_strategy. claude/ceph-study-identity-followup additionally contains 0047_ceph_correction_lineage. These are observed files; reserved Ortho0052–0055 and HR0056/0057 remain root coordination information, not files or numbers allocated here.

Inventory proposes ownership of these **22 additive tables**, with root-owned migration/contract adoption:

| Source | Exact tables | Ownership boundary |
|---|---|---|
| schema-proposal.ts | inventory_locations; inventory_item_unit_versions; inventory_approval_policies | Immutable location, package and approved policy evidence |
| schema-proposal.ts | purchase_requests; purchase_request_revisions; purchase_request_lines; purchase_approval_events | Exact version/content decisions; no stock or financial effects |
| schema-proposal.ts | purchase_orders; purchase_order_lines; purchase_order_source_allocations | Approved source allocations and frozen quote/conversion |
| schema-proposal.ts | goods_receipts; goods_receipt_lines; stock_lots; inventory_movement_allocations | Inspected receipts and allocations referencing existing inventory_movements |
| schema-proposal.ts | supplier_invoices; supplier_invoice_payable_links; supplier_invoice_receipt_allocations | Match/receipt reservation; finance owner creates existing payable via separate reviewed adapter |
| schema-proposal.ts | inventory_operations | Scoped actor/key/content/result evidence for atomic retries |
| custody-schema-proposal.ts | inventory_transfers; inventory_transfer_lines; inventory_transfer_acknowledgements; inventory_transfer_ack_lines | Immutable relocation documents explaining stock in source/transit/destination; no new clinic quantity, debt, cash or payroll ledger |

The transfer allocation read equals existing movement allocations plus transfer/acknowledgement deltas. Item locks serialize dispatch and acknowledgement; the writer refuses a discrepancy between tracked movement allocations and the existing clinic movement balance. It does not infer lot ownership for old movements. Pending receipt reads exclude completed transfers and page20. Doctor reads and acknowledgement use the fresh active authenticated user→doctor-party link, with no quote/cost JSON for doctors.

These tables do **not** implement consumption allocation, stocktake/disposal/recall correction, unique safe package closure, actual deduction events or financial settlement posting. Additional relations/constraints for those workflows must be designed with clinical and finance owners before reservation. Their required ownership and adapter contracts are in treatment-custody-contract.md and proposals/ATOMIC_WRITER.md.

Existing inventory_movements remains the sole clinic quantity ledger. Existing payables/expenses/payment allocations remain debt and cash sources; service_materials/materialRate remain their existing source owners. Existing append-only financial guards and inventory_movements_payable_uniq are untouched. Shared db.ts, migration registry, schema contracts, session/security policy and finance/commission writers have not been edited by the custody continuation.

Next root handoff: review the two unnumbered SQL modules and reserve coordinated migration ownership; adopt the narrow historical-unit lock and atomic lot/clinical writer contracts separately; approve an invoice→existing-payable adapter and explicit rational cost snapshot policy. Verify migration upgrade/restore with preserved synthetic historical balances before enabling these workflows. No release, data backfill or financial posting is authorized by this document.
