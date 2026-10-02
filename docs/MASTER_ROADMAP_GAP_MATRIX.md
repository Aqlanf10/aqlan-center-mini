# AQLAN CENTER MINI — Live Master Roadmap Gap Matrix

Canonical live execution matrix, audited 2026-10-02 UTC.

This is the single execution-status matrix for the owner's Master Roadmap. Existing technical-debt,
architecture and historical audit documents remain supporting evidence, not competing live backlogs.
No existing document currently covers this entire roadmap with current implementation evidence.

## Evidence boundary

- Audited MINI snapshot: `a1fd74f217541c19c75ad158d831e4eba59d2b67` (merged PRs 164–169); earlier broad capability tracing used `1010684`, with all later deltas reconciled
- Source inventory: 39 numbered migrations; source/tests/API references below establish implementation coverage, not completed clinical validation
- Functional benchmark inspected read-only: `Aqlanf10/aqlan-dental` at `9c375fbee53e23e00ab62cfabcf4bc91aaa60321`
- Benchmark contributes workflow ideas only. MINI retains its architecture, schema ownership strategy,
  currency-dimensional ledger, authorization, and canonical domain services
- Read-only Railway service metadata shows image `ghcr.io/railwayapp-templates/postgres-ssl:18`, supporting the intended major only; the live server/catalog has not been independently queried and no preflight log evidence was found
- This audit did not connect to Production PostgreSQL, run migrations, infer live adoption status,
  change patient data, or run a restore. Existing CI success is not schema equality or live adoption proof
- PRs 164–169 deployment/health and non-destructive functional evidence is recorded below. This matrix is not a claim that every future-roadmap acceptance scenario has been tested in Production

Status meanings: DONE = the named deliverable meets the full release/functional Definition of Done;
PARTIAL = working foundation exists but the named end-to-end requirement has a concrete implementation or verification gap;
MISSING = no corresponding persisted workflow was found in the inspected source; BLOCKED = an
unsafe/deferred operational step, not a reason to stop safe work; SUPERSEDED = an obsolete gap/design
replaced by verified current implementation. Implementation evidence alone does not close a phase. Rows whose implementation is present but whose full current workflow/release evidence has not been reconciled remain PARTIAL; this is a verification gap, not permission to rebuild them.

## Immediate safety queue

| ID | Priority | Gap / state | Evidence | Next bounded step |
|---|---|---|---|---|
| SAFE-01 | P1 | DONE: cross-patient tooth-chart visit references refused | PR165, merged 1010684, deployment SUCCESS/health HTTP 200 ready:true; canonical `recordToothCondition`; actual-writer, PG lock and built-HTTP tests; full CI 36935379185 | Preserve guard and verify subsequent relinking cannot undo it |
| SAFE-02 | P1 | DONE: new collections against inactive plans refused by PR167 | `isPlanFundedByAgreement`, `recordPayment`, `recordPlanInstallment`; actual API reproduction; `inactive-plan-collections` suites | Merged 740cbe4, deployment SUCCESS/health HTTP 200 ready:true; CI: 2,802 unit / 681 PG / 526 HTTP. Historical refunds/corrections and issued-invoice settlement retained; no Production financial mutation used |
| SAFE-03 | P1 | DONE: later unsigned-visit relinking protected by merged PR168 | `linkVisitToPatient`; `charted-visit-relink` unit/PG/HTTP tests | Merged main bd35fd7; deployment verification confirmed SUCCESS and health ready:true. Released PR167 preserves this guard and both documentation sections |
| SAFE-04 | P2 | DONE: finance cash/shift labels and configured-timezone display corrected by PR166 | Separate UI-only work; canonical drawer reconciliation remains authoritative | Merged a1fd74f; deployment SUCCESS/health HTTP 200 ready:true; live drawer amounts/labels/clinic-time display checked without record changes |
| SAFE-05 | P1 | PARTIAL: durable periodontal measurements still missing; misleading editor contained by PR169 | `components/DentalChart.tsx:57,244-250,636-900`: React state only; no matching API/schema path; mathematical helper `lib/dental.ts:220+` | Synthetic Production UI reproduced 5→2 mm after reload, with no save option/warning. Containment merged 667dcf8, CI: 2,793 unit / 677 PG / 523 HTTP, deployment/health/live notice verified. Durable patient-scoped audited persistence remains open |

Keep 2–3 independent active PRs at most. Sensitive
`lib/db.ts` changes integrate sequentially. Read-only auditing and isolated reproduction continue.

## 1. Schema safety and foundational debt

| ID | State | Current source of truth / proof | Actual gap and next safe slice |
|---|---|---|---|
| SCHEMA-01 / TD-REG-001 | PARTIAL | Immutable numbered migrations; `lib/migrations.ts`; runtime DDL in `lib/db.ts`; schema manifests and CI characterization | Two owners remain. Establish actual live catalog/registry state before any adoption decision |
| SCHEMA-01R | PARTIAL | Existing `readSchemaRegistrationPreflight` plus SELECT-only manifest projectors; this slice adds `db:preflight` with database-enforced read-only snapshot/timeouts and checksum/catalog summary tests | Complete this slice’s CI/review/release. Actual Production introspection remains unperformed; no adoption or equality claim |
| SCHEMA-01D | PARTIAL | `schema/schema-ownership-open-findings.pg18.json` has exactly 16 approved divergences: 12 appointment-column ordinals + 4 function definitions; `applicationSchemaEqual:false` | Characterization success is not equivalence. Resolve only reviewed additive/safe differences; no destructive ordinal convergence |
| SCHEMA-01A | BLOCKED | No fresh Production registry/equivalence evidence; rollback/restore acceptance remains incomplete | Adoption and retirement require safety evidence and an explicit safe run plan. The read-only preflight itself does not depend on a backup |
| SCHEMA-DEPLOY | MISSING | Dockerfile runner copies standalone Next output/static and entrypoint only | Deployment image has no deliberately supported numbered-migration CLI/assets. Package a governed runner only after design/rehearsal; do not change live schema as an experiment |
| SCHEMA-02 / TD-REG-002 | PARTIAL | `ensureSchema` memoizes within a process but executes CREATE/ALTER/trigger/index DDL on a cold process | Keep load-bearing compatibility until adoption is proven; do not remove/rewrite runtime DDL blindly |
| SCHEMA-03 / TD-REG-003 | PARTIAL | Runtime bootstrap has `SKIP_SEED` at db.ts:2042 and seeds below it; provisioning script itself invokes `ensureSchema` | Separate explicit, idempotent provisioning artifacts without changing existing data or forgetting required defaults |
| SCHEMA-RO-TRAP | SUPERSEDED | The former `db:status` read-only description was inaccurate: `migrationStatus` invokes `runBaselineSchemaProbe` for a nonempty unadopted DB; probe runs CREATE SCHEMA + baseline DDL then ROLLBACK | Never designate that command as SELECT-only preflight; rollback does not make DDL read-only |

## 2–6. Financial, multispecialty and daily clinical foundation

| Roadmap capability | State | Canonical implementation and executable evidence | Remaining closure work |
|---|---|---|---|
| BILL-1: installment-funded sessions are not billed twice | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. `PLAN_FUNDED_BY_AGREEMENT_SQL`, pricing/sign classification; PG `installment-plan-included.test.ts`, HTTP `installment-plan-collect-http.test.ts` | Preserved by released inactive-plan fix; do not create a second billing engine |
| Treating doctor per clinical work item | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. `signClinicalVisit` resolves/freezes treating doctor; PG `doctor-attribution.test.ts` covers own-doctor preservation, signer separation and priced-work refusal | Keep price-zero exception explicit. Fixed agreements without assigned providers can remain unattributed; do not invent a clinician or commission |
| Installment attribution by plan-item value | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. `attributeInstallment`, frozen invoice lines; PG doctor-attribution tests | Preserve exact sum, per-currency attribution and historical immutability |
| Commission rate/source/detail/lab/material attribution | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. `commissionReport`, event-time engine/history, `commission_case_overrides`; PG `doctor-commission-engine`, `commission-detail`, `commission-refund-aware`, doctor/specialty report attribution | Existing document headers saying "unmerged/not in production" are historical. Cross-currency/unattributed costs must stay explicit, not guessed |
| Plan collection lifecycle and correction integrity | PARTIAL | Current receipt/reversal/idempotency services; released PR167 guards | PR167 released with full PG correction/audit suites; retain historical exceptions and perform only authorized synthetic operational tests |
| Sign-off idempotency and checkout | PARTIAL | `signClinicalVisit`, `visitWalkout`, `checkout-db.ts`, `checkout-summary.ts`; PG `reception-checkout`, `chair-readiness`, `legacy-ortho-billing` | Core works; refresh current operational findings and prove interrupted/repeated user journeys after active fixes |
| One patient / one chart / one ledger | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. `patients`, per-patient clinical rows, `ledgerBalancesByCurrency`, existing patient file | Keep chart ownership/relink guards and patient duplicate confirmation; a top-five UI duplicate detector is not a complete census |
| Specialty cases, problem list, case status | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. Migration 0032 + `lib/cases.ts`, canonical DB writers, `PatientCases`; unit/PG/HTTP `specialty-cases` | Reuse for specialties; do not create a patient silo |
| Master plan, case links, priorities, dependencies | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. `plan_items.case_id/priority`, `plan_item_dependencies`; PG tests reject cycles/cross-patient links and show one master plan feeds multiple cases | Deep specialty workflows extend this foundation; no competing plan model |
| Coordinating vs responsible vs treating provider | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. Patient/plan coordinator, case responsible party, frozen procedure/invoice doctor; PG doctor-attribution/cases tests | Do not turn coordinator/referrer status into commission entitlement |
| Shared timeline / next action / specialty context | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. Patient timeline/Workflow, referral and case context; CASE-MODEL-1b and referral-arrival tests | Validate any new specialty-specific events through the same timeline |
| Internal referrals closed loop | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. Migration 0033; existing `patient_referrals`; REF-1/2/3, PG `internal-referrals`/`referral-arrival`, HTTP tests | Preserve external referrals/printing and explicit return-to-referrer acknowledgement |
| Reception readiness, overrides and chair workflow | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. `chair-readiness`, clearance fields in 0036, gated call/seat and audit; PG/HTTP readiness suites | Keep prior debt as attention by default; preserve authorized reasoned overrides |
| Clinical cockpit | PARTIAL | Today-visit context, plan/case/referral banner, images/lab/financial projection and checkout components | Compare full roadmap context list with actual UI; extend existing cockpit, not another patient page |
| Legacy orthodontic baseline | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. `ortho-baseline`, migration 0034, current clinical sign integration; PG legacy ortho/billing tests | Preserve true baseline and existing opening-balance/plan flows; never fabricate prior visits/invoices |
| Early multispecialty document's "no case model / no internal referrals" gaps | SUPERSEDED | `MULTISPECIALTY_PATIENT_ARCHITECTURE.md` §8 documents delivered slices 127–139 and implementation files/tests confirm them | Read historical design tables as historical, not current backlog |

## 7–16. Expansion audit (ordered; do not mistake generic foundations for complete specialties)

| Roadmap phase | State | Existing reusable foundation | Evidence-backed gap / acceptance before implementation |
|---|---|---|---|
| Endodontics | PARTIAL | Generic case, FDI chart, endo template/session plan, doctor attribution, crown dependency | Dedicated persisted canal/working-length/procedure-detail workflow not found in inspected MINI paths. Benchmark actual Dental Pro workflow before designing a narrow case-detail extension |
| Prosthodontics | PARTIAL | Crown/bridge templates, lab order/shade/trial/delivery tracking, case and billing links | Audit full specialty clinical records and outcome workflow; do not duplicate laboratory truth |
| Periodontics | PARTIAL | Six-site measurement UI and pure assessment helper; generic case + scaling template | Editable measurements are client-state only. Highest concrete specialty data-persistence gap found so far; synthetic Production browser reproduction confirmed; local launcher is socket-blocked, so no local-browser pass is claimed |
| Oral surgery | PARTIAL | Surgery template, case, consent, prescriptions/post-op instructions and referrals | Dedicated pre-op/operative/post-op governed record sequence not found. Dental Pro's surgery types/workflow are a functional benchmark only |
| Implantology | PARTIAL | Implant+restoration template, case, surgery/lab/material ledger foundation | Audit implant-specific clinical traceability and staged records before a new detail slice |
| Restorative/general | PARTIAL | Tooth chart, procedure lines, fillings template, sign-off and financial attribution | Validate full context/longitudinal clinical record requirements; do not label generic procedure entry as complete specialty workflow |
| Pediatric | PARTIAL | Primary-tooth chart and unified case vocabulary | Dedicated pediatric assessment/treatment protocol not found; reuse identity/guardian and existing clinical record |
| Cosmetic | PARTIAL | Case vocabulary, veneer/service/lab support | Dedicated cosmetic clinical objectives/outcome workflow not established by this audit |
| Advanced orthodontics | PARTIAL | One ortho case, wires/elastics/stages/photos, visits/sign integration, baseline, ceph | Benchmark structured exams, alternatives A/B/C, extraction reasoning, anchorage, records checklist, model analysis and retention follow-up one by one |
| Seven requested cephalometric analysis families | PARTIAL | Implemented foundation confirmed; full current workflow/release proof still to be reconciled. `lib/ceph.ts` registry includes Steiner/Tweed/McNamara/Ricketts/Downs/Jarabak/Wits; mathematical tests, reference sets, comparison/superimposition APIs | Preserve engine. Family support does not establish external clinical validation or every advanced roadmap feature |
| Ceph norms / quality / serial / superimposition | PARTIAL | Reference sets, comparison and superimposition components/tests exist | Audit quality-control completeness, timelapse, frontal/photo analysis against mathematical fixtures; do not substitute AI |
| VTO | MISSING | Existing geometric/ceph primitives can be reused | No dedicated VTO workflow found; only later after base reliability |
| Ortho-surgical shared workflow | MISSING | Ortho/case/referral/ceph foundation; generic surgery context | No joint-case/surgeon-review/joint-plan lifecycle found. Ceph recommendation text is not an implemented surgical workflow |
| Radiology order→perform→review→result | PARTIAL | Patient image/document uploads, ceph studies, patient timeline | A governed radiology-order workflow with case/requester/result links is not established by current upload screens |
| Prescriptions and post-treatment instructions | PARTIAL | Prescription APIs/printing, procedure templates/safety acknowledgement/save workflow | Audit prescriber/date/context and appearance in unified timeline/portal against full requirement |
| Patient portal/PWA | PARTIAL | Existing portal, `app/manifest.webmanifest`, `public/sw.js`, portal APIs/tests | Verify every requested section, privacy and allowed-file scope; evolve existing portal |
| Remote waiting != physical arrival | MISSING | Current check-in/queue estimate is physical-arrival oriented | Add a distinct remote state only after contract audit; never reuse arrival for "on my way" |
| React Native / Expo | MISSING | Same MINI API/auth/backend to be retained | No native app package found in MINI; blocked by PWA maturity in roadmap sequencing, no parallel backend |
| Professional procurement | PARTIAL | Stock movement→supplier payable, existing vouchers, WAC, statement, opening payable; `PURCHASING_GAP_ASSESSMENT.md` | Current createInventoryMovement db.ts21858–21960 has no purchase currency/method input, creates base-currency payables only and refuses supplier links on returns. Close audited cash/FX/credit-note gaps before PO/multi-line/partial receiving, using existing ledger |
| Multi-location | BLOCKED | Current single-center operations | Defer until current center stable; eventual additive default location, scoped schedules/resources/inventory/reports/permissions |
| HR | BLOCKED | Optional after clinical/financial completion | Do not make employees/attendance/leaves/payroll a prerequisite for clinical work |
| Backup/restore/TD-08A | BLOCKED | Existing backup/restore implementation and draft47 retained | Explicitly LAST; only an actual immediate Production data hazard elevates this to P0. No deletion/restore experiment |

## Verified benchmark notes

Dental Pro `frontend/src/components/dental/PerioAssessment.tsx` posts a patient-linked record to
`/api/general/perio`; `GeneralController.cs` and `GeneralService.cs` expose create/read persistence.
This is evidence of the useful capability, not permission to copy its DTO/schema. It also swallows
client save errors, which MINI should not copy. MINI's existing six-site model is richer than that
single-probing-depth benchmark and should be retained with explicit durable save/error behavior.

Dental Pro `frontend/src/types/surgery.ts` models pre-op, operative and post-op records; its
`orthoSurgical.ts` models surgeon review, joint plan, readiness, approvals and continuation. These
are workflow references only; their persistence/authorization/production quality has not been
certified by this audit.

## Next safe sequence

1. Release the true read-only schema preflight and this canonical matrix after full CI and review
2. Collect authorized schema evidence through that safe preflight; operational adoption remains a separate blocked step
3. Design durable six-site persistence after schema safety evidence. PR169 containment is released; it does not complete persistence
4. Resume roadmap order using existing domain owners and small reviewed slices

## Unresolved audit work (not silently counted DONE)

- Production catalog/registry state, live server major, and exact baseline adoption evidence
- Complete cockpit/UI acceptance tracing and safe current-flow checks
- Each advanced orthodontic/ceph sub-capability, each portal section, radiology order lifecycle
- Procurement B1–B3 implementation gap is corroborated by current writer; reproduce each financial impact before its repair
- Patient duplicate census and carefully specified merge SOP. `scripts/verify-merge.mts` tests schema
  behavior; it is not the patient-merge procedure or a SELECT-only duplicate census. Use the canonical
  `mergeDuplicatePatient` service and PG patient-merge tests as evidence; never automatically merge
