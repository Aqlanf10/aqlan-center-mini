# AQLAN CENTER MINI — Live Master Roadmap Gap Matrix

Canonical live execution matrix, audited 2026-10-02 UTC.

This is the single execution-status matrix for the owner's Master Roadmap. Existing technical-debt,
architecture and historical audit documents remain supporting evidence, not competing live backlogs.
No existing document currently covers this entire roadmap with current implementation evidence.

## Evidence boundary

- Audited MINI snapshot: `4d8fd18d2846cfee5ea435fb9f6fdb8de3d9f751` (merged PRs 164–175); earlier broad capability tracing used `1010684`, with later changes reconciled. PR174 packaged preflight ran successfully against the actual Production application target at 2026-10-02 02:38 UTC; PR175 billing-service transaction repair is released: deployment `37ea6151-53c8-4bf1-ab92-fe0df2625d7f` SUCCESS at 02:41:59 UTC, health HTTP 200/ready:true at 02:44 UTC, and read-only live finance/services catalog verified
- Source inventory: 39 numbered migrations; source/tests/API references below establish implementation coverage, not completed clinical validation
- Functional benchmark inspected read-only: `Aqlanf10/aqlan-dental` at `9c375fbee53e23e00ab62cfabcf4bc91aaa60321`
- Benchmark contributes workflow ideas only. MINI retains its architecture, schema ownership strategy,
  currency-dimensional ledger, authorization, and canonical domain services
- Live application-target evidence now exists: the guarded PR174 packaged preflight used the canonical `databaseUrlForProject` resolver (`aqlan_center_mini_v2`) in the authenticated Railway web Console. Its report verifies PostgreSQL major 18, a database-enforced read-only/repeatable-read transaction, verified TLS, 82 tables and 1,045 columns. The report intentionally omits the database name; target binding is established by the guarded execution context, not inferred from the JSON. The earlier default-`railway` database observation is not used as application evidence
- The Production preflight read catalog/registry metadata only: registry absent, zero registered rows, versions 0001–0039 missing, no unknown versions or checksum/name mismatches. Empty mismatch arrays with an absent registry do not mean equivalence. `adoptionAssessment: NOT_PERFORMED`, `schemaEquivalence: NOT_ASSESSED`; no patient/financial row read, application-data modification, migration, adoption or restore was performed. Sanitized complete report: [production-readonly-preflight-2026-10-02.json](production-readonly-preflight-2026-10-02.json), SHA-256 `6b0343f99a8046430f5af2b61ab57ac39f5c6cda7cacb43610582d75c7c2df1d`. Execution: deployment `21e4183b-ca44-4e45-82f4-b84499f77305`, instance `4c661e64-f1b8-45e1-9b6a-867e3f6083f5`, with project/service/environment guards matched
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
| SAFE-05 | P1 | PARTIAL: durable periodontal measurements still missing; misleading editor contained by PR169 | `components/DentalChart.tsx:57,244-250,636-900`: React state only; no matching API/schema path; mathematical helper `lib/dental.ts:220+` | Synthetic Production UI reproduced 5→2 mm after reload, with no save option/warning. Containment merged 667dcf8, CI: 2,793 unit / 677 PG / 523 HTTP, deployment/health/live notice verified. PR172 further preserves unrecorded measurements/summary state (merged 2c16e11, deployment SUCCESS/health HTTP 200 and live unavailable notice verified). Durable patient-scoped audited persistence remains open |
| SAFE-06 | P2 | DONE: global header uses resolved clinic timezone | PR170, merged 73cab80; `AppShell` receives canonical server timezone | Deployment SUCCESS, health HTTP 200 ready:true, live header verified against clinic date/time |
| SAFE-07 | P1 | DONE: valid service-specific waiting entries survive repeated cold starts; PR173 | PostgreSQL 23505 reproduced at obsolete patient-only index; current per-service/generic indexes already support these entries | Remove obsolete index recreation only; preserve legacy drop/current guards. After integration with PR171, 112 focused units and 33 PG tests passed, alongside independent migrations 0001–0009 legacy/concurrency proof; full combined CI passed; merged bdb2e55, deployment 37985edb SUCCESS at 2026-10-02 01:22 UTC, health HTTP 200 ready:true and live waiting-list read verified without record changes |
| SAFE-08 | P1 | DONE: default billing-service rows and marker commit on one checked-out PostgreSQL client; PR175 | Deterministic real-PG lock/atomicity/rollback/concurrency regressions fail on prior pool-query statements and pass after fix; exact catalog/owner semantics retained; full latest-main CI 2,883 unit / 705 PG / 527 HTTP | Merged `4d8fd18`; deployment `37ea6151` SUCCESS at 02:41:59 UTC, health HTTP 200/ready:true at 02:44 UTC and live finance/services catalog loaded read-only. No existing Production corruption is asserted or repaired |
| SAFE-09 | P1 | PARTIAL: lab bootstrap omits canonical scope/shade/description and can leave a partial first catalog; fresh-only repair under verification | Actual synthetic PG bootstrap plus `createLabOrder`: full-arch DNT_FULL at a 1,000 YER rule and six teeth generated 6,000 order/payable because stored scope defaulted to single_tooth. Read-only live catalog also shows DNT_FULL as single-tooth; historical overcharge is not established | Seed all canonical fields atomically only when the whole catalog is empty; isolate/log failure so independent defaults continue. Existing nonempty catalogs, owner edits/deletions and historical financial records remain untouched; any existing-catalog correction needs separate owner-preserving review |

Keep 2–3 independent active PRs at most. Sensitive
`lib/db.ts` changes integrate sequentially. Read-only auditing and isolated reproduction continue.

## 1. Schema safety and foundational debt

| ID | State | Current source of truth / proof | Actual gap and next safe slice |
|---|---|---|---|
| SCHEMA-01 / TD-REG-001 | PARTIAL | Immutable numbered migrations; runtime DDL; schema manifests/CI characterization; actual Production read-only preflight at 02:38 UTC confirms an absent migration registry on the application target | Two owners remain. Live evidence is collected, but schema equivalence and adoption are not assessed; do not infer permission to run migrations or retire compatibility |
| SCHEMA-01R | DONE | PR171 read-only projector plus PR174 packaged runner; actual MINI application-target metadata captured at 2026-10-02 02:38 UTC: PostgreSQL 18, read-only/repeatable-read, verified TLS, registry absent/0 registered/39 missing | The bounded metadata-evidence deliverable is complete, with the sanitized report linked above. Schema equivalence, migration adoption and runtime-DDL retirement remain separate and unapproved |
| SCHEMA-01D | PARTIAL | `schema/schema-ownership-open-findings.pg18.json` has exactly 16 approved divergences: 12 appointment-column ordinals + 4 function definitions; `applicationSchemaEqual:false` | Characterization success is not equivalence. Resolve only reviewed additive/safe differences; no destructive ordinal convergence |
| SCHEMA-01F | PARTIAL | Offline comparison of PR174 Production evidence with fresh source schemas: all 11 counts and 8 section hashes match; columns, constraints and internalTriggers differ. Optional bounded source-known fingerprint drilldown now has isolated-PG18 privacy/history/snapshot tests and packaged provenance | Production differences remain unattributed. Review/release the diagnostic slice first; no Production drilldown has run. Unknown identities/text are withheld, existing aggregate hashes and 16 findings stay intact; no adoption, normalization, migration or runtime-DDL retirement follows |
| SCHEMA-01A | BLOCKED | Fresh Production registry evidence exists: absent registry, versions 0001–0039 missing. Equivalence/adoption were explicitly not assessed; rollback/restore acceptance remains incomplete | Adoption and retirement still require reviewed equivalence/safety evidence and an explicit safe run plan. Registry absence is not authorization to apply baseline migrations; the read-only preflight itself did not depend on a backup |
| SCHEMA-DEPLOY | PARTIAL | PR174 merged `e8d5c2f`; deployment `21e4183b` SUCCESS at 02:17:12 UTC. Docker build verified `build:preflight`, 39 immutable assets, packaged help and runner copy; authenticated Railway Console successfully executed that packaged runner at 02:38 UTC | Read-only artifact delivery and actual application-target execution are verified. The broader governed numbered-migration executor/delivery remains missing and unverified; no automatic startup query, migration execution, adoption or schema-equivalence certification is supplied |
| SCHEMA-02 / TD-REG-002 | PARTIAL | `ensureSchema` memoizes within a process but executes CREATE/ALTER/trigger/index DDL on a cold process | Keep load-bearing compatibility until adoption is proven; do not remove/rewrite runtime DDL blindly |
| SCHEMA-03 / TD-REG-003 | PARTIAL | Runtime bootstrap retains `SKIP_SEED`; provisioning still invokes `ensureSchema`. PR175 pins billing-service seed/marker to one transaction (8 PG regressions; full CI 2,883 unit / 705 PG / 527 HTTP), merged `4d8fd18`. Current lab-bootstrap slice preserves all canonical metadata atomically for an empty catalog only | Keep required defaults and owner intent. Lab bootstrap previously omitted scope/shade/description, causing wrong synthetic payable quantities; fresh-only repair and local failure isolation are under verification. Existing Production catalog and historical amounts are not corrected automatically |
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

1. PR175 release/deployment/health/read-only catalog verification is complete. Release the narrow lab-bootstrap metadata/atomicity repair after full CI and review; preserve every existing owner catalog and historical amount
2. Reconcile the captured Production metadata with the safe schema-ownership evidence. Actual target introspection is complete; schema equivalence/adoption remain unassessed and operational adoption stays blocked
3. Review the existing Production lab catalog through an explicitly authorized owner-preserving path; fresh-only bootstrap repair does not remediate existing rows. No historical overcharge is established by the synthetic reproduction
4. Design durable six-site persistence after schema safety evidence, then resume roadmap order using existing domain owners and small reviewed slices. PR169/172 containment does not complete persistence

## Unresolved audit work (not silently counted DONE)

- Schema equivalence and exact baseline adoption evidence remain open. Production major 18 and catalog/registry metadata are now verified by the bounded read-only report; do not list those completed observations as unperformed
- Complete cockpit/UI acceptance tracing and safe current-flow checks
- Each advanced orthodontic/ceph sub-capability, each portal section, radiology order lifecycle
- Procurement B1–B3 implementation gap is corroborated by current writer; reproduce each financial impact before its repair
- Patient duplicate census and carefully specified merge SOP. `scripts/verify-merge.mts` tests schema
  behavior; it is not the patient-merge procedure or a SELECT-only duplicate census. Use the canonical
  `mergeDuplicatePatient` service and PG patient-merge tests as evidence; never automatically merge
