# Inventory implementation checkpoint

This feature branch is a review checkpoint, not an enabled release. New procurement/custody tables await coordinated migration registration. The application returns503 `schema_not_ready` when those tables are absent; it never creates them automatically. Do not run proposal SQL against a deployed database.

## User flows available in the synthetic fixture

- `/inventory/review`: administrator Arabic/English valuation, explicit missing/estimated costs, search/pages and complete branded report print. A missing acquisition price is never represented as known zero.
- `/inventory/procurement`: authenticated clinic requester submits several registered package quantities with a need reason. The request changes no stock, supplier debt or cash. Administration can now record a reasoned monetary revision and exact partial approval at `/inventory/procurement/review`, with explicit valuation/source and selected request print. Order/receipt/match interfaces remain incomplete; their underlying command transactions are tested through HTTP.
- `/inventory/custody`: administrators dispatch valid tracked lots between store/doctor locations through a distinct transit location. The receiving doctor or administrator confirms accepted quantities or inspected returns to source. Transfers retain clinic ownership; consumption is separate and is not implemented by this form. Doctor statements contain only their custody scope and no quote costs.
- Custody Arabic/English print shows allocated quantities, unavailable stock and safety instructions. It is not a financial settlement. Safe empty packages can be reconciled in a future closure workflow; sharps/contaminated material must never be returned to storage or retrieved from waste for counting/photos.
- If a write result is uncertain, inputs remain locked and the explicit confirmation button retries the identical command/key. Check the confirmed result before starting another operation.

## Verification environment

Use repository-required Node22 and a fresh isolated PostgreSQL18 database with synthetic fixtures. Follow the repository’s PostgreSQL/security global setup; its reset/drop behavior is confined to its own synthetic test databases. Check connection parameters before every run. Never reuse a deployed database URL.

The continuation’s exact run manifests and log hashes are in `continuation-verification.json`; the checkpoint archive includes the logs, screenshots, PDFs and source manifest. Prior exact-head CI result is in `ci-checkpoint-659f61d2.json`. Full scenario execution is separately documented in `acceptance-audit.md`; listed69 requirements are not69 executed tests.

Relevant repository commands are `typecheck`, `lint`, `build`, focused `test`, `test:postgres` and `test:security-http`. The new relevant suites are inventory-foundation, inventory-procurement-domain, inventory-treatment-custody, inventory-lots, inventory-http-registration, postgres/inventory-procurement-store, postgres/inventory-custody-transfer and security-http/inventory-{foundation,procurement}-http-ui. Official Chromium download was blocked locally; local browser evidence explicitly uses installed Chromium151.0.7922.173 through INVENTORY_CHROMIUM_EXECUTABLE. CI keeps its existing browser installation and guards.

## Integration and remaining work

Root must review22 named additive tables in `migration-reservation-request.md`, reserve migration ownership, and verify upgrade/restore without changing historical quantities/debts. Shared `db.ts`, session/security rules, migration registry/contracts, supplier/payment/commission/HR writers and CI remain owned by their active teams. Only the previously delegated literal procurement GET/POST matrix entry was edited.

Existing inventory_movements, payables, expenses, service_materials and materialRate remain their authoritative sources. Current matching creates no payable/payment. Existing manual/automatic issue paths still require coordinated lot/expiry allocation enforcement. Patient cost and D−A settlement modules remain arithmetic/source contracts until their existing clinical/finance adapters and authorized posting are integrated. No automatic disciplinary debt, salary deduction or payment is created.

Next independent work is the order/inspection/match administration and printable-document phase. Root controls serial integration and release after invoice, HR and Ortho/Ceph practical acceptance. No production/staging publication, supplier communication or live-data mutation is part of this checkpoint.
