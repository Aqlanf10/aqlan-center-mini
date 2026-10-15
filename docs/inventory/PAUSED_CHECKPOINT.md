# Inventory independent completion & Argon repair checkpoint — 2026-10-15

Resumed on 2026-10-15 under the root assignment authorizing independent inventory, procurement, and doctor custody completion and the subsequent Argon repair cycle (`R00–R12`) on branch `feat/inventory-completion-20261015` starting from pinned commit `3ebaf9e28587b036f4952593bf0046598cf7b06b` (`feat/inventory-procurement-custody`). This authorization replaces the older pause notice within the independent inventory scope only; it does not authorize branch merges, deployment, or shared financial/schema mutations.

Observed reference heads:
- `origin/main`: `d79df32b1ec8250d11c2d20fd284fd914e4da4ad` (PR #333 merged; migrations through `0061_financial_idempotency_keys.sql`)
- `origin/feat/inventory-procurement-custody`: `3ebaf9e28587b036f4952593bf0046598cf7b06b` (exact match with pinned start commit)
- `origin/feat/hr-main-recovery-20261015` (PR #334): `2c0522e2e092438ea2823f9d58391018cf59c7ea` (reserving `0056–0058`)
- Preserved prior branch head before R00–R12 repair commit: `e74481cb6250bbefea1393248eff5e883fcc96f6`

Completed in the R00–R12 repair cycle on top of `e74481cb6250bbefea1393248eff5e883fcc96f6`:
1. **R00 — CI Build/Test Diagnosis & Repair**:
   - Diagnosed GitHub Actions Run `38793021949` (`#2013`, job `116622173970`) on `e74481cb6250bbefea1393248eff5e883fcc96f6`: `npm test` failed on 1 test out of 8,973 (`__tests__/ai-assistant-tools.test.ts:111:27`, `returns friendly offline notice for inventory`) because `getInventorySummary` returned `success: false` without `"غير متصلة"` when `!context.isDbConnected`.
   - Fixed `getInventorySummary` in `lib/ai-tools/inventory-tools.ts` to return a friendly offline notice (`success: true`, `textSummary` containing `"غير متصلة"`, `warnings: ["inventory_unavailable", ...]`, `cards: [{ title: "المخزون", value: "غير متصل — غير مؤكد", tone: "calm" }]`) without fabricating zero stock or healthy status, while keeping `success: false` on runtime query exceptions when `context.isDbConnected === true`.
2. **R01 & R02 — Annual Custody Settlement Integrity (`proposeSettlement`, `proposeAnnualCustodySettlement`)**:
   - Enforced `postingState === "posted"` on `priorAdjustments` in `proposeSettlement` (`unposted_settlement_adjustment`) and required `sourceBacked === true` for `"ready_for_authorized_review"`.
   - Hardened `proposeAnnualCustodySettlement` in `lib/inventory-domain/custody-store.ts` with `pg_advisory_xact_lock` on `(doctorPartyId, periodId, currency)`, period format validation (`invalid_period_id`), server-side verification against `custody_usage_events` (`settlement_source_mismatch`), exclusion of unposted rows from `priorAdjustments`, and `"provisional"` status whenever a server-backed deduction ledger is absent.
3. **R03 — Independent Waste Approval (`custody_waste_approvals`, `approveCustodyWaste`)**:
   - Added append-only `custody_waste_approvals` table to `lib/inventory-domain/custody-schema-proposal.ts`, `approveCustodyWaste` (`custody.approve_waste`) in `lib/inventory-domain/custody-store.ts` and `app/api/inventory/procurement/route.ts`, and row-locked `FOR UPDATE` allowance verification in `recordCustodyUsage` when `kind === "approved_waste"`.
4. **R04 & R06 — Server-Verified Package Safety, Depleted Lot Selection & Closure Lineage (`closeCustodyPackage`)**:
   - Implemented `classifyDefaultPackageSafety` and `resolvePackageSafetyWithFieldObservation` in `lib/inventory-domain/custody.ts` forbidding hazard downgrade on sharp/contaminated items (`package_hazard_downgrade_forbidden`).
   - Enforced server-side custody lot inbound ownership (`lot_not_in_custody_location`), exact history reconciliation (`package_history_mismatch`), and global `pg_advisory_xact_lock` on `packageId` and `evidenceEventId` in `closeCustodyPackage`, and exposed `closableLots` (including `0`-balance depleted lots) in `readDoctorCustody` and `components/inventory/DoctorCustody.tsx`.
5. **R05 — Clinical Context Verification (`recordCustodyUsage`)**:
   - Verified `patientId`, `visitId`, `caseId`, and `procedureId` against `patients`, `visits`, `treatment_plans`, `planned_visits`, and `doctorOwnsPatient` in `recordCustodyUsage` (`clinical_context_mismatch`, `clinical_context_forbidden`).
6. **R07 & R08 — Historical Reconciliation Quarantine & Chronological Two-Pass Allocation (`planHistoricalReconciliation`, `reconcileHistoricalMovements`)**:
   - Preserved `requiresExpiry: true` and created missing-expiry legacy lots with `status = "quarantined"` (`R07`).
   - Enforced chronological inflow-before-outflow validation (`unresolved_historical_lineage`) and two-pass allocation supporting mixed-state items with existing tracked lot capacity (`R08`).
7. **R09 & R11 — Quarantine Current-Date Guard, Disposal & Excess Arrival Decisions (`planQuarantineResolution`, `resolveQuarantineReceipt`, `planInspectedReceipt`)**:
   - Validated `resolutionDate <= currentDate` and current-date shelf life on quarantine release (`R09`).
   - Wired `"dispose"` quarantine resolution across domain, schema proposal, store, and `ProcurementOperations.tsx`, and wired `excessDecision` (`return_excess_to_supplier`, `hold_for_order_amendment`) into `planInspectedReceipt`, `postInspectedReceipt`, and `ProcurementOperations.tsx` (`R11`).
8. **R10 & R12 — Allowlisted Error Sanitization, Correlation IDs, Locator Uniqueness & Bilingual UI**:
   - Replaced blacklist-only `safeInventoryErrorMessage` with `ALLOWLISTED_DOMAIN_ERROR_MESSAGES` + `DEFAULT_SAFE_INVENTORY_ERROR_MESSAGE`, expanded `sanitizeInventoryAuditDetails`, and added `correlationId` to 500 responses (`R10`).
   - Restored Playwright locator uniqueness (`"الدفعة الصالحة"` and `"كمية التحويل"` exclusive to dispatch form), distinguished `custody.consume` completion feedback, and wrapped validation/command messages in `t(...)` across `ProcurementOperations.tsx` and `ProcurementAdministration.tsx` (`R12`).

Shared files untouched: `lib/db.ts`, `lib/session.ts`, `lib/migrations.ts`, `schema/*`, shared invoice/payable/payment/commission/HR writers, and `.github/workflows/ci.yml`.
