# Acceptance audit — 69 scenarios

Complete integrated scenarios executed: **0/69**. Subset tests below are not a complete acceptance claim. Migration, finance/clinical/settlement adapters and release remain coordinated root gates.

| ID | Status | Verified subset | Exact remaining work |
|---|---|---|---|
| P01 | partial-domain-or-PG-fixture | No stock/debt/cash; request API and UI persist once. | Coordinated migration activation; full approved deployment remains unrun. |
| P02 | partial-actual-PG-HTTP-browser | Actual Arabic admin UI and PG preserve original requested3boxes and save approved2boxes=100cartridges with reason and explicit value/FX snapshot. | English administration copy, policy/delegation setup UI and full integrated lifecycle. |
| P03 | partial-actual-PG-HTTP-browser | Admin monetary revision preserves old document/approval, requires fresh approval, serializes concurrent revisions and refuses demand revision after order allocation; actual390/1280 UI. | Quantity/supplier amendment workflow after ordering and full integrated scenario. |
| P04 | partial-actual-PG-HTTP-browser | Fresh active actor/admin checks, exact API gate and frozen currency ceiling. | Delegation UI/policy configuration and branch model: base has one clinic scope. |
| P05 | partial-domain-or-PG-fixture | Exact 3×50=150 and 150−2=148 arithmetic; frozen conversion; receipt PG. | Old manual/automatic issue writer and historical unit lock integration. |
| P06 | partial-domain-or-PG-fixture | Cumulative source allocation and concurrent order requests cannot overspend approval. | Multi-request order creation UI. |
| P07 | partial-domain-or-PG-fixture | Partial inspected receipt creates 100 pieces once with 50 remaining. | Receipt administration UI and coordinated migration. |
| P08 | partial-domain-or-PG-fixture | Rejected has no stock; quarantine not available; replacement fulfillment stays open. | Replacement document workflow and quarantine release approval. |
| P09 | partial-domain-or-PG-fixture | Planner and locked receipt reject excessive arrival. | Explicit excess-arrival decision UI/policy. |
| P10 | partial-domain-or-PG-fixture | Transactional audit failure rolls back receipt and stock. | Actual multi-item browser receipt failure scenario. |
| P11 | partial-actual-PG-HTTP-browser | PG concurrent replay plus real request response-loss retry with identical payload/key. | Lost-response receipt/invoice browser journeys; only request uncertainty witnessed. |
| P12 | partial-domain-or-PG-fixture | Two simultaneous different receipts cannot exceed locked remaining quantity. | Coordinated production schema; UI concurrent receipt journey. |
| P13 | domain-only; legacy-issue-integration-blocked | Pure FEFO allocates exact valid lots and reservations. | Connect allocations to existing manual/automatic issue writers. |
| P14 | domain-only; legacy-issue-integration-blocked | Pure FEFO rejects unsafe lots; new custody dispatch/accept also rejects unsafe lots. | Existing manual/automatic issue paths still permit expired-only stock: release blocker. |
| P15 | partial-real-HTTP-browser; complete-scenario-unrun | Real HTTP/browser WAC completeness separates missing price and known free stock. | Finalize procurement invoice valuation adapter; historical valuation policy. |
| P16 | partial-domain-or-PG-fixture | Three-way match reserves received quantity without additional movement or debt. | Shared finance owner must atomically create one existing payable and immutable links; no posting implemented. |
| P17 | partial-domain-or-PG-fixture | Supplier/calendar-year duplicate identity and missing-number review; PG invoice duplication gate. | Finance posting transaction and supplier invoice review UI. |
| P18 | partial-domain-or-PG-fixture | Invoice before arrival held for match; never fabricates stock. | Authorized advance/exception path through existing supplier payment engine. |
| P19 | partial-domain-or-PG-fixture | Price/quantity variances detected; no financial posting. | Variance approval policy and actual posting UI. |
| P20 | unrun-full-scenario; limited-independent-evidence | Immutable FX arithmetic only; old supplier-payment regressions separately passed. | Procurement payable integration plus full cross-currency payment E2E has not run. |
| P21 | unrun-full-scenario; limited-independent-evidence | No procurement advance allocation implemented. | Shared supplier advance allocation writer, permission/FX and cash-conservation E2E. |
| P22 | unrun-full-scenario; limited-independent-evidence | No procurement supplier return/reversal writer implemented. | Independent stock/debt/cash return documents using existing finance writers. |
| P23 | partial-domain-or-PG-fixture | Exact minor-unit apportionment, shipping/discount and stable rounding unit tests. | Persist cumulative allocation approval and verify final payable charges. |
| P24 | unrun-full-scenario; limited-independent-evidence | Historical valuation is not silently repriced by new modules. | Invoice-after-consumption adjustment adapter/audit and commission-owner review. |
| P25 | unrun-full-scenario; limited-independent-evidence | Existing inventory concurrency regression passed; new FEFO planner only. | Shared manual/automatic usage identity and locked allocation writer. |
| P26 | unrun-full-scenario; limited-independent-evidence | Single-clinic store/transit/doctor transfer tested. | Base has no branch identity: cross-branch authority and partial differences not implemented. |
| P27 | unrun-full-scenario; limited-independent-evidence | No stocktake posting implemented. | Count-cutoff/freeze/reconcile policy and shared writer concurrency. |
| P28 | unrun-full-scenario; limited-independent-evidence | No exact-lot disposal posting implemented. | Approved lot-specific disposal and existing movement allocation writer. |
| P29 | domain-only; legacy-issue-integration-blocked | Pure planner rejects recalled lot. | Persist recall events, trace known patient/custody use and old-history limits. |
| P30 | partial-real-HTTP-browser; complete-scenario-unrun | Non-admin JSON omits prices/payable/supplier refs; valuation endpoint denied; existing tool read failures truthful. | Full export/attachment/print coverage beyond owned review surface. |
| P31 | partial-real-HTTP-browser; complete-scenario-unrun | Equal reorder boundary low; read failure cannot yield false safe stock. | Full operator journey and root integration verification. |
| P32 | unrun-full-scenario; limited-independent-evidence | Custody refuses unallocated historical stock; no invented ownership or new stock/debt. | Historical balance import preview/reconciliation, opening migration and preservation rehearsal. |
| P33 | unrun-full-scenario; limited-independent-evidence | No import workflow implemented. | Idempotent import mapping/reject report and unknown-price review. |
| P34 | partial-domain-or-PG-fixture | Server rejects supplier role/activity/scope mismatch. | All related receipt/financial attachment access and authenticated spoofing matrix. |
| P35 | partial-domain-or-PG-fixture | Existing audit writer in same transaction; mandatory audit failure rollback tested. | Finance approvals/posting/reversal audit and shared audit action vocabulary. |
| P36 | partial-domain-or-PG-fixture | Partial example 100 received/50 remaining, invoice200SAR matched and no debt/cash. | Complete150/148, payable300SAR, payment100SAR, remaining200SAR requires shared finance/issue adapters. |
| P37 | partial-actual-PG-HTTP-browser | Actual valuation/custody Arabic/English, Arabic request/administration and existing inventory/item/movement UI at390/1280; branded request/approval, valuation and custody PDFs generated and text inspected. | Order/inspection/match interfaces/prints and English request/administration copy. |
| P38 | unrun-full-scenario; limited-independent-evidence | Synthetic local PG/build and prior exact-head CI passed; no orders/messages sent. | Coordinated migration upgrade/restore rehearsal and authorized later release: unrun. |
| P39 | domain-only; persistence-HTTP-E2E-unrun | Exact3/1/8SAR and sub-minor cost arithmetic. | Package settings/admin UI and applied movement valuation. |
| P40 | domain-only; persistence-HTTP-E2E-unrun | Custody transfer changes allocation only; empty evidence changes no stock. | Kit decomposition/component value persistence and UI. |
| P41 | domain-only; persistence-HTTP-E2E-unrun | Pure treatment costs isolate patient case/visit/procedure and linked return. | Shared clinical source adapter and actual movement allocations. |
| P42 | domain-only; persistence-HTTP-E2E-unrun | Pure usage duplicate/overallocation rejected. | Durable unique usage identity, locked issue and visit-sign transaction. |
| P43 | domain-only; persistence-HTTP-E2E-unrun | Pure shared-visit supplies are not repeated; estimated quantities remain estimated. | Versioned service_materials source and confirmation UI. |
| P44 | domain-only; persistence-HTTP-E2E-unrun | Pure cost/category/registration completeness never gives trustworthy zero. | Replace existing patient-wide profitability read via coordinated adapter and UI. |
| P45 | domain-only; persistence-HTTP-E2E-unrun | Pure staged performed revenue separated from collection and agreement cap. | Ortho/agreement owner source adapter and completion estimates. |
| P46 | domain-only; persistence-HTTP-E2E-unrun | Pure exact overhead allocations, idle capacity and duplicate/direct/capital rejection. | Approved expense/capacity policy and persisted period source allocations. |
| P47 | domain-only; persistence-HTTP-E2E-unrun | Pure180/200=10%,25% target240 and valid commission denominator. | Authorized pricing simulation UI and agreement basis adapter. |
| P48 | domain-only; persistence-HTTP-E2E-unrun | Pure snapshots/quotes immutable and currency mixing rejected. | Persist historical applied valuations and show replacement quote source/date. |
| P49 | partial-actual-PG-HTTP-browser | Actual PG/HTTP/browser store100→70store+30doctor over two15 transfers; no stock/debt/cash write. | Coordinated transfer migration; period reporting and full valuation adapter. |
| P50 | domain-only; persistence-HTTP-E2E-unrun | Pure30−8−2=20; clinic92. | Clinical consumption/return existing-writer integration not implemented; transfer UI does not record consumption. |
| P51 | partial-PG-and-domain | Actual doctor-to-doctor transfer conserves quantity/value; pure count difference held. | Stocktake approval/source cutoff and consumption correction transaction. |
| P52 | domain-only; persistence-HTTP-E2E-unrun | Pure collections10000→1000 versus commission3000→300. | Existing effective doctor contract/materialRate source history. |
| P53 | domain-only; persistence-HTTP-E2E-unrun | Pure actual-applied600 less reversal100 =D500. | Commission-owner actual deduction and linked reversal adapter. |
| P54 | domain-only; persistence-HTTP-E2E-unrun | Pure D−A positive/negative/zero and supplemental directions. | Authorized supplemental posting into existing doctor account; no automatic posting. |
| P55 | partial-PG-and-domain | Pure closing custody excluded from A; actual transfers create no purchase/debt. | Opening import/period close/rollforward transaction and incomplete reconciliation policy. |
| P56 | domain-only; persistence-HTTP-E2E-unrun | Pure contract exclusions and held waste exception. | Effective item coverage and independent approved exception source. |
| P57 | domain-only; persistence-HTTP-E2E-unrun | Pure supplemental proposal excludes previous adjustments. | Concurrent settlement approval/idempotency/source membership PG constraints not implemented. |
| P58 | domain-only; persistence-HTTP-E2E-unrun | Pure wrong doctor/period rejected. | Stable frozen cross-period source sets, late collections and doctor transfer reconciliation. |
| P59 | domain-only; persistence-HTTP-E2E-unrun | Pure explicit immutable settlement FX; mixed currencies rejected. | Approved valuation source and original/converted/FX difference statement. |
| P60 | domain-only; persistence-HTTP-E2E-unrun | Pure materials100+grossfee300−recovery40 =360. | Actual finance recovery source and profitability read adapter. |
| P61 | partial-actual-PG-HTTP-browser | Actual doctor own custody read/receiver only; anotherdoctor/reception denied; no automatic finances. | Immutable objection, separate settlement approval/posting and own financial statement not implemented. |
| P62 | domain-only; persistence-HTTP-E2E-unrun | Missing valuation/count keeps pure settlement provisional; legacy allocation discrepancies block transfer. | Historical importer and reviewed closing quantity/cost completeness. |
| P63 | domain-only; persistence-HTTP-E2E-unrun | Pure arithmetic composition plus actual purchase→custody transfer subset. | Actual case consumption/return/count/settlement/payment complete PG/browser journey unrun. |
| P64 | domain-only; persistence-HTTP-E2E-unrun | Pure empty package closes evidence without stock/cost reversal. | Persist unique package closure actor/lot/custody linkage and UI. |
| P65 | domain-only; persistence-HTTP-E2E-unrun | Pure120−80=40 unexplained for review without debt/usage. | Persist investigation and independently approved cause. |
| P66 | domain-only; persistence-HTTP-E2E-unrun | Pure supplied-history rejects repeated package/evidence IDs. | Concurrent unique package/evidence PG closure not implemented. |
| P67 | domain-only; persistence-HTTP-E2E-unrun | Pure remaining-stock early replenishment and emergency self-approval rejection. | Trusted capabilities, emergency request approval transitions and audit UI. |
| P68 | partial-domain-and-Arabic-UI | Pure hazard disposal and actual Arabic/English custody UI/printed instructions forbid sharps/waste returns. | Package-specific safe disposal evidence/closure workflow and its complete browser journey. |
| P69 | domain-only; persistence-HTTP-E2E-unrun | Pure unknown loss creates no doctor/assistant debt. | Any authorized loss posting must share one unique decision across accounts and reverse independently. |
