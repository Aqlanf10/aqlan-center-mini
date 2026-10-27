# Coordinated schema reservation request

**Historical request below (2026-10-16).** The active 2026-10-27 inventory
continuation adds supplier finance, durable command transport and an identity
proposal. Use [the current exact manifest](proposals/migration-manifest-20261027.json)
for names and dependencies, and [the operational completion plan](OPERATIONAL-COMPLETION-20261026.md)
for activation holds. Nothing here assigns a migration number. The later work
includes narrow authenticated-session and managed-restore hooks; statements
below about untouched shared files describe the historical checkpoint only.

No migration number has been selected or registered. Root controls serial integration after invoice, HR and Ortho/Ceph acceptance. These SQL modules are proposals explicitly applied in synthetic PostgreSQL fixtures only. Runtime is disabled by default through the server-only rollout gate. Authentication precedes that gate; admitted authenticated requests receive `inventory_integration_disabled`. Explicit test enablement still fails with `schema_not_ready` when proposal tables are absent. The environment key is not authorization for live activation; Production remains closed and no settings are changed.

Verified against `origin/main` (`6090722977a37981ddf56585c180f782b5a5249b`) on 2026-10-16:
- `0059_invoice_debt_installments.sql`
- `0060_historical_treatment_documents.sql`
- `0061_invoice_correction_lineage.sql`
- HR history occupies `0056–0058`; Ortho migrations include `0051_ortho_treatment_strategy.sql` and `0052_ortho_assessment.sql`.
- Inventory schema proposals remain strictly unnumbered (`lib/inventory-domain/schema-proposal.ts` and `lib/inventory-domain/custody-schema-proposal.ts`). Root must recheck the registry and coordinate any future assignment; this document reserves no number.

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

