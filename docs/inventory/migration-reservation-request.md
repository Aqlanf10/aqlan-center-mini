# Coordinated schema reservation request

No migration number has been selected or registered. Root controls serial integration after invoice, HR and Ortho/Ceph acceptance. These SQL modules are proposals explicitly applied in synthetic PostgreSQL fixtures only. Runtime fails closed with `schema_not_ready` until a reviewed migration exists.

Observed migration ranges as of 2026-10-15:
- `origin/main` (`d79df32b1ec8250d11c2d20fd284fd914e4da4ad`): `0001–0051` and `0059–0061` (`0059_invoice_service_discount_attribution.sql`, `0060_discount_approvals.sql`, `0061_financial_idempotency_keys.sql`).
- Ortho/Ceph (`0052–0055`) and HR (`origin/feat/hr-main-recovery-20261015` `2c0522e2e092438ea2823f9d58391018cf59c7ea`: `0056–0058`) occupy `0052–0058`.
- Therefore, inventory schema proposals remain strictly unnumbered (`lib/inventory-domain/schema-proposal.ts` and `lib/inventory-domain/custody-schema-proposal.ts`) until root assigns the next post-`0061` migration slot.

Inventory proposes ownership of these **29 additive append-only tables**, with root-owned migration/contract adoption:

| Source | Exact tables | Ownership boundary |
|---|---|---|
| schema-proposal.ts | inventory_locations; inventory_item_unit_versions; inventory_approval_policies | Immutable location, package and approved policy evidence |
| schema-proposal.ts | purchase_requests; purchase_request_revisions; purchase_request_lines; purchase_approval_events | Exact version/content decisions; no stock or financial effects |
| schema-proposal.ts | purchase_orders; purchase_order_lines; purchase_order_source_allocations | Approved source allocations and frozen quote/conversion |
| schema-proposal.ts | goods_receipts; goods_receipt_lines; stock_lots; inventory_movement_allocations; quarantine_dispositions | Inspected receipts, quarantine release/return/dispose resolutions, and allocations referencing existing inventory_movements |
| schema-proposal.ts | supplier_invoices; supplier_invoice_payable_links; supplier_invoice_receipt_allocations | Match/receipt reservation; finance owner creates existing payable via separate reviewed adapter |
| schema-proposal.ts | inventory_operations | Scoped actor/key/content/result evidence for atomic retries |
| custody-schema-proposal.ts | inventory_transfers; inventory_transfer_lines; inventory_transfer_acknowledgements; inventory_transfer_ack_lines | Immutable relocation documents explaining stock in source/transit/destination; no new clinic quantity, debt, cash or payroll ledger |
| custody-schema-proposal.ts | custody_waste_approvals; custody_usage_events; custody_stocktakes; custody_package_closures; custody_annual_settlements; custody_settlement_objections | Independent admin waste approvals, append-only doctor custody consumption/waste/return events, physical stocktake counts, server-verified safe empty-package / disposal closures, and annual D−A settlement proposals/objections with zero automatic debt or wage deduction |

Existing `inventory_movements` remains the sole clinic quantity ledger. Existing `payables`/`expenses`/`payment_allocations` remain debt and cash sources; `service_materials`/`materialRate` remain their existing source owners. Existing append-only financial guards and `inventory_movements_payable_uniq` are untouched. Shared `lib/db.ts`, migration registry, schema contracts, session/security policy and finance/commission writers have not been edited.

