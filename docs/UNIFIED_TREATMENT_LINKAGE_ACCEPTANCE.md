# Unified treatment linkage acceptance ledger

Repository: Aqlanf10/aqlan-center-mini. Source review only, 2026-10-10.

## Evidence boundary

- Baseline main: `148fcbeac229cb279848e6ea37049d1599a4fafe`.
- Combined PR322 candidate: `ca20d2f389167ef4d78eaa7b75a2d7e7281042ec`, tree `ea2c4eacd39f2bd40f0890e2daf49458353e8b68`. This contains Ceph 0047 and Ortho 0051 source. Its intentionally stale generated catalogs are not accepted deployment evidence.
- Signed-case guard v2 is a separate 18-path source candidate. Its changed signed-attribution behavior must be composed deliberately, not overwritten or claimed already released.
- New suites below are AUTHORED / NOT RUN. No application, test, typecheck, lint, build, SQL, installation or production process was executed to prepare them. There is no new branch, commit, PR or published result from this worker.
- Existing filenames below were checked against the combined candidate tree. Only the specific source inspections described below establish behavior; filename existence or an older successful CI does not prove a current acceptance result.

## Cohesive new source

1. `__tests__/security-http/unified-linkage-legacy-reception-journey.test.ts`: four actual built-app HTTP writer journeys, real isolated PostgreSQL. Registers historical care, checks replay, records independent consent, creates arrival, saves and signs linked clinical work, receives partial/full/no new payment, and completes reception handling. Verifies receipt concurrent replay, preserved item/case, no new invoice, ledger/workflow/walkout/new financial-context parity, patient-currency opening attribution, and retained debt after deferral/handling. Values are YER minor units; 300000 agreed, 120000 before system, 180000 opening, 30000 receipt, 150000 due.
2. `__tests__/security-http/unified-linkage-context-http.test.ts`: eight real HTTP reader tests over deliberate synthetic graph fixtures. Exact item/case/Ortho convergence; plan-only non-selection; closed/new episodes; foreign-patient/mismatched context; recorded historical visit vs current open case; malformed references; live plan-permission revocation; anonymous/portal refusal. Reads must leave fixture snapshots unchanged. Direct historical-row insertion tests readers, not sign/close/create writers.
3. `__tests__/security-http/unified-linkage-context-browser.test.ts`: two unmocked live browser reader journeys at 390/1280 RTL. Select exact closed case through item URL, retain diagnostics and case on reload, explicitly select later case, reject duplicate identity query rather than defaulting to another case. Screenshots in `artifacts/unified-linkage/` are synthetic review material; they require artifact retention and human visual inspection. No screenshot has been generated yet.

## Fifteen mandatory journeys

| # | Journey and invariant | Source evidence / new coverage | Remaining gate or gap |
|---|---|---|---|
| 1 | Draft → approval → invoice → first payment → schedule; one obligation | Existing `postgres/plan-installment-idempotency.test.ts`, `security-http/installment-plan-collect-http.test.ts`; financial explicit-selection candidate | BLOCKING IMPLEMENTATION GAP: current installment writer issues collection invoices. Future invoice-backed schedule/settlement writer and migration policy are not implemented by these suites. Do not call existing mode the requested future mode. |
| 2 | Invoice first creates/reuses intended plan/item/case, opens exact Ortho | Inspected existing `security-http/invoice-clinical-linkage-http.test.ts` and `invoice-clinic-continuity-journey.test.ts`; new context readers/browser; financial explicit-selection source | Re-run invoice writer with explicit existingPlanId/item selections against final composed head. Current new browser fixture proves selection/read only. |
| 3 | Ortho first → explicit compatible plan/funding → included adjustment → sign/out | Existing invoice-origin Ortho full journey, legacy Ortho backend tests; navigation/financial context candidate | Case-first comprehensive chooser, audited inclusion policy and actual sign/checkout journey still require proof. A plan_id or any Ortho invoice is not sufficient coverage. |
| 4 | 300000 / 120000 / 180000 → collect 30000 → 150000 everywhere | New real-writer legacy/reception partial case; existing `postgres/legacy-treatment.test.ts`, `security-http/legacy-treatment-http.test.ts` source inspected | Authored, not run. Report/cash aggregate endpoint parity still needs a separate witness; shift-linked receipt SQL alone is not full report proof. |
| 5 | Fully historically paid care creates no opening, invoice or new receipt | New already-paid writer case; existing legacy suites | Authored, not run. Historical paid amount does not assert clinical consent or completed care; consent is recorded separately in new journey. |
| 6 | Multiple plans, mixed specialties, exact item obligation | Financial candidate `postgres/invoice-explicit-selection.test.ts` source covers multi-plan explicit IDs, omitted ambiguity, replay and plan-close race; new resolver plan-only non-selection and mismatched edges | Full multi-plan/multi-specialty writer and cross-currency checkout/browser journey remains necessary. Do not infer a single plan per patient. |
| 7 | Closed episode stays historical after genuine new treatment | New closed/new context reader and historical-visit reader; live browser preserves selected closed case | Fixtures seed graph/history intentionally. Real close/new-case writer sequence remains a separate required gate. |
| 8 | Prior unlinked Ceph T1 explicitly attached to correct case | Combined `postgres/ceph-study-case-link.test.ts`, `security-http/ceph-study-identity-ui-journey.test.ts` | Preserve combined 0047 source and genuine catalog recovery. Re-run current case-selection flow; never auto-attach all studies to latest case. |
| 9 | Approved-study correction preserves origin/case/stage/lineage | Combined `postgres/ceph-correction-lineage.test.ts`, `ceph-correction-lineage-migration.test.ts` and Ceph UI journey | No duplicate replacement implementation here. Exact-head real PostgreSQL/HTTP/browser result still required. |
| 10 | Paid invoice cancellation/correction retains balance/coverage/commission history | Existing `postgres/receipt-correction.test.ts`, `security-http/receipt-correction-http.test.ts`, existing invoice containment journey; signed guard v2 | Financial owner also authored actual invoice/payment/correction reader PG source. All are unrun. Verify frozen commissions and closed periods on composed head; do not rebuild paid commissions. |
| 11 | Double click, lost reply, reload, parallel tabs commit once | New receipt two-tab same-key + replay; historical registration replay; inspected existing invoice clinic lost-response browser and installment idempotency suites | New tests model post-commit replay; actual transport-loss browser evidence comes from existing suite and must be rerun. Historical relink/sign/closure race evidence belongs signed guard v2. |
| 12 | Cross-patient, FDI, jaw, specialty, stale scope refused server-side | New resolver foreign-patient/mismatch tests; signed guard v2 `clinical-case-identity` PG, owner-route and Endo/specialty HTTP changes | Resolver identity is not clinical compatibility validation. Run v2 wrong FDI/jaw/unknown-scope and actual writer refusal witnesses. |
| 13 | Doctor/reception/assistant/admin boundaries; revoked access applies now | New reception handling doctor refusal, wrong patient refusal, resolver private-user plan permission revocation/portal denial; existing specialty/Endo/Ortho strategy authorization suites | Client same-role principal/authority-key changes and late response containment need separate component/live UI proof. Assistant has no shared `h.sessions.assistant`; never invent it. Use existing private-assistant fixture/caller after checking permissions; full role matrix still required. |
| 14 | Plans, invoice, ledger, cash, checkout, reports agree per currency | New financial-context/account/ledger/workflow/walkout agreement; real receipt/shift identity; existing `postgres/daily-clinic-report-invoice-linkage.test.ts`, `daily-clinic-report-writers.test.ts` | Must join exact receipt IDs to actual cash/report endpoints and refresh screens after partial/refund/correction. No claim of full aggregate report parity from SQL or unit-only calculations. |
| 15 | RTL phone/desktop, explicit destination, refresh, legacy links, retained drafts | New unmocked 390/1280 reader screenshots/reload; navigation owner unit/component draft/legacy alias tests; existing phone-width and Ceph journeys | Screenshots not run. Unsaved draft/Back/forward and all origins need exact-head native review. New suite checks document overflow; it does not prove every interactive element has adequate hit area. |

All statuses are source coverage, not acceptance completion. No row is declared fully complete.

## Reception submatrix

New real-writer parameterized suite covers:
- partial 30000 collection: after signature and handling, debt remains 150000;
- full 180000 collection: after signature and handling, debt is 0;
- deferred collection: handling reason is explicit, no receipt, debt remains 180000;
- historical paid-in-full: no opening/no receipt/new invoice, debt 0;
- repeat handoff writes preserve same decision; repeat/concurrent payment returns same receipt; wrong patient and doctor handoff mutation refuse.

The real arrival endpoint is exercised. Chair call/seat transitions and independent already-open reception polling are covered by existing clinic/signature sources, not newly asserted by this parameterized suite. The existing `reception-exact-checkout-ui.test.ts` mocks response data and is presentation/uncertainty coverage, not financial integration evidence. The real polling/signature portion of `reception-signature-handoff-ui.test.ts` uses seeded historical arrival and a genuine signing writer; its other mocked sections must retain their separate labels.

## Implemented posting semantics vs future mode

- Historical care already uses a documented agreement and one opening effect through existing writers. Prior paid money is historical metadata, not a new cash receipt. Real later opening-currency receipt reduces the patient-currency position.
- Existing installments continue `historical_invoice_on_collection`. Existing invoices and receipt numbering are not rewritten. Installing a financial-reference reader does not create a new posting mode.
- Current readers deliberately return `currentAgreementRemainingMinor: null` / `not_allocated`, and document allocated remaining is unavailable. A shared opening or unallocated credit cannot be assigned to individual agreements/items by amount or name.
- Future invoice-backed schedules require a real writer contract, explicit mode boundary, accounting preview, transaction-owned idempotency/fingerprint, original/correction/reversal lineage, frozen-period/commission handling and synthetic upgrade fixtures. Keep this as a blocking tracked implementation gap, not a skipped “green” test pretending an endpoint exists.

## Runtime integration contract and preflight

The three new files are discovered by the existing security-HTTP suite; no new runner, database name or workflow is added. They require the candidate navigation and financial-context implementations plus the existing combined `_ortho-strategy-live-fixture.ts`.

Before authorizing CI, the integrator must:
1. Compose exact combined successor + signed guard v2 + navigation and financial DTOs, preserving published migration bytes and reviewed catalog recovery.
2. Check all changed exports/route paths against these tests. Actual current paths: `/api/patients/:id/legacy-treatments`, `/api/plans/:id/consent`, `/api/visits`, `/api/visits/:id/clinical`, `/api/payments`, `/api/visits/:id/reception-handoff`, ledger/workflow/walkout. Payment operation key is an `Idempotency-Key` header; legacy registration key is a JSON field. Handoff status is `handled`, not `completed`.
3. Keep fixed CI boundary: GitHub repository quality job, existing PostgreSQL 18 service, existing disposable `aqlan_sec_http` database, loopback 5432 and app loopback3217. Existing fixture validates database identity/owner, seed markers and version. No arbitrary TEST_DATABASE_URL is authorization. The inherited global setup owns provisioning/cleanup; these tests do not add any reset or DROP path.
4. Use existing typecheck/lint/build/full security/PG/schema gates without deadline inflation or skip. The new tests are not runnable on an uncomposed old main because candidate imports/endpoints intentionally do not exist there.
5. Retain exact-head source/run metadata and synthetic screenshots. Confirm all 14 new parameterized cases actually execute (4 writer + 8 reader + 2 browser); no placeholder skipped tests are counted.
6. Run full historical compatibility and report suites, review the remaining gaps above, then use separate staging/native acceptance. Production finance/data conversion and backup deletion remain out of scope.

## Explicit remaining test/design stubs (not executable fake APIs)

- Invoice-backed installments and audited historical migration are design/implementation gaps: do not create a test calling a nonexistent posting route.
- Full cash/report parity: choose current released collection/report endpoint contracts and assert exact receipt identities plus native-currency aggregate deltas, not all-patient totals guessed from a shared fixture.
- Assistant and patient access revocation: use isolated owned users and current permission engine, never edit shared secdoctora/secreception seeds.
- Real case closure/new episode and Ortho case-first chooser: run actual authors' writer APIs once explicit work-selection payload freezes.
- Multi-plan explicit invoice selection test ownership belongs financial-context worker. Shared signed relink/signer/closure races belong signed-case-identity-v2. Do not duplicate or overwrite those files.

Financial DTO owner independently source-checked the new writer suite property assertions on 2026-10-10: current fields match. This is source review, not a runtime pass.
