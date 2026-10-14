# Inventory implementation checkpoint

Scope: Library `libfile_05f8e16e32508191aefa2093c44f9a21`, all 499 lines read, 104993 readable bytes. SHA-256 `ed47678714550343cc489825db47686bbbf36c2446b8344229c8d2a90ac53e81`. Signed materialization failed with `library file transfer failed: download failed`; supported Library text reads reconstructed the exact stated line/byte counts. Consumer-local source: `/workspace/inventory-task/source/scope-read.md`.

Base: `148fcbeac229cb279848e6ea37049d1599a4fafe`; local branch `feat/inventory-procurement-custody`. No merge, push, publication, live data, supplier message, security infrastructure or CI changes authorized. Release follows invoices, HR and Ortho/Ceph and belongs to root. Node 22.23.3; isolated fresh Docker PostgreSQL 18.6, loopback port 54339, synthetic data only. Existing workspace databases and historical files are untouched.

## Phase 0

`requirements-ledger.json` records every numbered/bulleted source requirement, 18 audit findings and all 69 acceptance scenarios. Its status is evidence-based; listing a scenario is not executing it. `branch-ownership.json` is the exact read-only fetched comparison against open invoice/HR/Ortho/Ceph heads. Repository AGENTS.md and local Next route guidance read. Workspace `.agents` is empty; repository `.agents` absent.

Inventory owns new `lib/inventory-domain/*`, inventory-specific routes/UI, inventory tests and these documents. Treatment/custody and procurement calculations are delegated into disjoint new files. Existing global financial math, `materialRate`, `db.ts`, permissions/session, supplier and commission writers, migration chain and schema contracts have other active owners. Do not overwrite shared files with old complete copies.

## Integration and release hold

Migration numbers 0052–0055 (Ortho) and 0056/0057 (HR temporal) are reserved. No number selected here. Requested coordinated ownership/reservation for: item/package unit versions, locations, purchase request/approval, order/source allocation, receipts, lots/movement allocation, supplier invoices/receipt allocation, idempotent operations, transfer/count/return documents, treatment allocation/template versions, custody policies/package evidence/material settlements.

Existing `inventory_movements` remains quantity source; lot/location allocations describe that source. Transfers retain clinic quantity/value and never imply consumption. Existing `payables`, `expenses`, payment allocations and supplier settlement remain debt/cash sources. Receipt stock insertion must not call the old supplier-linked purchase writer then create another payable. Supplier invoice posting owns one payable with unique source relation. Existing `inventory_movements_payable_uniq` and historical links stay intact. `service_materials`, `material_rate_history` and commission/payroll events remain authoritative. D is actually applied deductions net reversals, not theoretical materialRate; proposed settlement D−A never creates automatic wage deduction or cash.

Shared proposals required: lock base-unit changes using the same item-row lock as movements; include existing party/payable IDs in list projection; transaction-aware inventory insertion without supplier debt; atomic audit/outbox; unique operation/source effects; exact clinical allocation and return links; capability checks through current session model. Shared writer edits are blocked until root assigns them.

At eventual integration, refresh then-current approved base, reconcile owned hunks, retain invoice linkage and payment correction/void, supplier currency/overpay/reversal, commission history/access checks; rerun their regression gates and new tests. No zero-risk claim. Staging release/restore acceptance cannot run under this local-only authorization.

## Gates

Initial status: all behavioral, PG, HTTP, browser, build, migration, restore and release gates UNRUN. Later evidence must record exact source checkpoint, command, result/count and limits here.

## Resumed checkpoint — 2026-10-14

Environment resumed successfully; original owned files and branch were intact. HEAD remained the pinned base while source was in the working tree. No reset or overwrite of prior work. Shared db owner confirmed: root. New instruction authorizes independent checkpoint push and Draft PR for review, while merger/publication still belongs to root. No expensive new agents spawned on resumption.

Brand: Library HTML reference resolved but transfer failed (`download failed`) and text reads returned `Transport closed`. Root supplied git reference 4538f57bb0171ee8d4b9428316633b331e024c0b. The specified review and summary/account PNGs were extracted and visually inspected, then applied within inventory CSS only. Global sidebar/chrome is unchanged. Runtime font remains bundled IBM Plex Arabic. Scoped design contract: DESIGN.md.

Observed before fixes: four desired foundation witnesses failed (price JSON, unknown-as-zero, reorder equality, false safe read failure). Independent real PG reproduction also observed historical unit mutation, expired-only out acceptance, repeated direct purchase creating two movements/payables, and missing legacy movement link projection. The first three shared writer defects remain blocked/pending root adoption, not silently called fixed.

Completed independent phases: foundation price/valuation/reorder/read-error fixes; real RTL/English valuation screen and generated report print; exact units and procurement/treatment/custody domain modules; additive unnumbered schema plus actual request/approval/order/receipt/match transactions tested on PG18; transactional audit and retry/concurrency tests. Phase 2 request UI and command API source prepared. Source-only narrow shared proposals are under proposals/.

Observed checkpoint validation: 179 focused unit tests passed (11 files); 130 PostgreSQL tests passed (10 files including existing invoice/supplier/commission regressions); typecheck, targeted lint, diff check and Next production build passed. Earlier 4 foundation HTTP/browser tests passed with actual 390/1280 Arabic/English images and PDFs; final combined HTTP/browser run passed 37 and failed 4 new procurement tests at the unchanged shared POST 405 guard. Official Playwright browser install failed with 403 Domain forbidden; local browser evidence uses installed Chromium 151.0.7922.173, recorded explicitly. No skipped new procurement case is counted as a pass.

Source regression suites exercised: inventory, WAC/concurrency/audit, stock supplier linkage, supplier payable overpayment, doctor commission engine, refund-aware commission, invoice correction and clinical linkage. Built HTTP regressions exercised supplier payments and RBAC. Full repository unit/PG/security suites, full lint, scan money, CI audit, environment parity, schema ownership/contracts, migration/restore, all 69 complete journeys and release gates are unrun or blocked. This is a review checkpoint, not release approval.

Exact next steps: root review/adopt one-line HTTP registration, reserve named schema migration ownership, apply narrow unit-lock/projection patches on approved base and validate concurrent first-movement history safety; then rerun new HTTP/UI tests. Continue monetary request revision/approval and order/receipt/match interfaces; add root-approved payable adapter and valuation snapshots; wire lot allocations to every consumption path; connect precise case returns and doctor custody/approved D−A adjustment with existing finance. Keep production/publication held until serial integration and practical acceptance.

The unchanged HTTP permission contract also reports 12 passed /2 failed, both identifying the unregistered new literal route. The proposed registry patch passes git apply --check against the pinned base, as do projection/unit-lock proposals. These checks do not mean root adopted them.

## Authorized guard integration and refreshed evidence

Root explicitly authorized only `/api/inventory/procurement: { GET: CLINIC, POST: CLINIC }` in lib/http-permissions.ts. Applied one line; matching code, general roles, other entries, db.ts and migration/schema registries are unchanged. Exact registration and dynamic item/movement precedence, unknown path and undeclared method refusal: 16 tests passed. The refreshed built-app round passed 42 tests across procurement/foundation UI, supplier payments and RBAC. Doctor and reception management attempts are rejected; inactive actor fails through an existing cookie. The store re-read of a revoked actor passes independently in PostgreSQL.

The repeated PG fixture initially failed during setup because its fixed policy version already existed (11 cases unrun). The fixture now inserts a new explicit immutable policy version without resetting prior test data; rerun 11/11 passed. Previous 130-test regression round remains recorded separately rather than being counted twice. Current final focused units are 179 plus the separate 16 route-contract checks. Build/typecheck/targeted lint/diff checks pass. Full 69-scenario, full CI/security matrix, migration/restore and release remain unrun/blocked.

Actual images now include request-ar-390/1280 and valuation-ar/en-390/1280 plus branded generated PDF reports. Browser is system Chromium 151.0.7922.173; official Playwright download was blocked by 403. Images were visually inspected. Existing shared sidebar remains at the pinned base and is deliberately outside the inventory styling change. No publication, merge, supplier messages or live data operations.
