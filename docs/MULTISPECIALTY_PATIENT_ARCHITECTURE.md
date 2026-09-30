# Multispecialty Patient Architecture

**ONE PATIENT → ONE CLINICAL RECORD → MANY SPECIALTY CASES**

Date: 2026-09-29.
Base: `main` @ `c586b24`.
Companions:
- `PATIENT_CHAIR_WORKFLOW_AUDIT.md`
- `DENTAL_PMS_WORKFLOW_BENCHMARK.md` (§ Multispecialty)
- `RECEPTION_TO_CHECKOUT_CHANGE_IMPACT.md`
- `INTERNAL_REFERRAL_WORKFLOW.md`

This is a design document. Nothing described here as *target* exists until its slice is merged.

---

## 0. Conflict check against work already done

| Earlier decision | Conflict with the principle? | Action |
|---|---|---|
| **Audit §5: "A case = a `treatment_plans` row; no new table."** | **YES.** A master multidisciplinary plan holds items from many specialties, so the plan cannot *be* the case. Keeping this would force one plan per specialty, the opposite of a master plan. | **Corrected here:** a specialty case is its own small entity (`clinical_cases`). Plan items *link* to a case, and one master plan can feed many cases. Nothing had been built on the old assumption. |
| BILL-1: installment-funded plans invoiced once (sessions included) | No. It is plan-level billing and works the same for a master plan. | Kept. |
| DOCATTR-1 (planned): treating doctor per work item; installments attributed by plan-item doctors (D1) | No. It is required by this principle. | Kept and made a prerequisite. |
| CASE-1 (planned): legacy orthodontic baseline on `ortho_cases` | No. The orthodontic case becomes *one kind* of specialty case (bridged, §3). | Kept; linked to the case model. |
| Existing patient file tabs (5) | No. | Kept. Specialty content lives inside «العلاج» and «زيارة اليوم». No new top-level tabs. |

---

## 1. Current state (verified on `main`)

| Concept | Exists? | Where |
|---|---|---|
| One patient record | **YES** | `patients` (one row; `patient_number`); every clinical and financial table keys on `patient_id` |
| One patient ledger | **YES** | invoices and payments per patient, balances per currency (`ledgerBalancesByCurrency`); no per-specialty accounts |
| Coordinating / primary doctor | **YES** | `patients.primary_doctor_id`; `treatment_plans.primary_doctor_id` (plan coordinator) |
| Multispecialty plan | **PARTIAL** | `treatment_plans` + `plan_items` (`category` = specialty, `doctor_id` = responsible provider, `tooth_code`, `billing_rule`, `session_count`, `planned_visit_number`). One plan *can* hold several specialties today. Missing: priority, dependencies, a case link, a referral link. |
| Specialty case | **PARTIAL** | Only orthodontics: `ortho_cases` (+ `ortho_adjustments`, ceph, photos, `patient_diagnoses.ortho_case_id`). No generic case for endo, perio, implant or prostho. |
| Treating doctor per work item | **PARTIAL** | `visit_procedures.doctor_id` → `invoice_items.doctor_id` (F-2: not defaulted or frozen; F-3: installment lines carry no doctor) |
| Problem list | **NO** (diagnoses are versioned narratives) | `patient_diagnoses` (label/content/version, linked to a visit or orthodontic case); `tooth_conditions` (chart) |
| Shared timeline | **PARTIAL** | `patientTimeline()` + `PatientTimeline.tsx`: visits, plans, appointments, invoices, payments, lab, documents, orthodontic adjustments. Missing: specialty, doctor and case per event, referrals, permission-scoped filtering. |
| Referrals | **EXTERNAL ONLY** | `patient_referrals` (see `INTERNAL_REFERRAL_WORKFLOW.md`) |

## 2. Benchmark summary (details in `DENTAL_PMS_WORKFLOW_BENCHMARK.md`)

- **Open Dental:**
  - one patient chart;
  - a **treating provider on every procedure**;
  - the **referral is attached to the procedure**, with statuses (None/Declined/Scheduled/Consulted/InTreatment/Complete) and a "Referred Procedure Tracking" report;
  - a **problem list** (Active/Resolved/Inactive);
  - an **Ortho Case** entity per patient.
- **Dentrix:**
  - **multiple treatment-plan cases per patient**, some kept in-office and others referred;
  - case statuses Proposed/Accepted/Referred/Rejected/Completed;
  - referred procedures are marked on the chart;
  - a "Referred to Doctor" report;
  - payments split by the **provider who performed** the work.
- **CareStack:** inbound and outbound referrals in one hub, with **automatic updates to the referring provider** (visit summaries, plan, case status); treatment-plan **phases**.
- **Rules extracted:**
  - **MS-1:** one chart and one ledger; cases and plans are views inside it.
  - **MS-2:** production follows the procedure's treating provider.
  - **MS-3:** a referral attaches to a *procedure / plan item*, not to the patient in general.
  - **MS-4:** a referral has a tracked status and closes the loop back to the referrer.
  - **MS-5:** a problem list with active/resolved status.
  - **MS-6:** cases have their own status and completion.

## 3. Target design

### 3.1 Roles (distinct, never conflated)

| Role | Stored in | Meaning | Earns commission? |
|---|---|---|---|
| Coordinating / primary doctor | `patients.primary_doctor_id` (exists); `treatment_plans.primary_doctor_id` (plan coordinator, exists) | Follows the overall plan, receives referral results | **No**, not by the role alone |
| Case responsible doctor | `clinical_cases.responsible_party_id` (**new**); `ortho_cases` via its bridge | Owns a specialty case | **No**, not by the role alone |
| Treating doctor | `visit_procedures.doctor_id` → `invoice_items.doctor_id` (exists; defaulted and frozen by DOCATTR-1) | Performed the work item | **Yes.** It is the *only* commission key. |
| Referring doctor | `patient_referrals.doctor_party_id` (exists) | Sent the referral | No |
| Receiving doctor | `patient_referrals.to_party_id` (**new**, internal only) | Accepted the referral | Only via their own treating work |

### 3.2 Specialty case — `clinical_cases` (new, additive)

```
clinical_cases(
  id SERIAL PK,
  patient_id INT NOT NULL REFERENCES patients ON DELETE RESTRICT,
  specialty TEXT NOT NULL,               -- same vocabulary as services.category / referral specialties
  title TEXT NOT NULL,                   -- «علاج عصب — سن 36»
  site TEXT NULL,                        -- teeth / region, e.g. "36", "46", "upper arch"
  problem TEXT NULL,                     -- diagnosis / problem summary
  responsible_party_id INT NULL REFERENCES parties,
  status TEXT NOT NULL DEFAULT 'active'  -- active | waiting | completed | closed | cancelled
  started_on DATE NOT NULL DEFAULT CURRENT_DATE,
  completed_at TIMESTAMPTZ NULL, outcome TEXT NULL,
  ortho_case_id INT NULL UNIQUE REFERENCES ortho_cases,   -- bridge: an orthodontic case is a specialty case
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

- **Orthodontics bridge.**
  - `ortho_cases` stays the orthodontic *detail* (wires, phase, adjustments, ceph) and nothing moves.
  - The unified case list reads `clinical_cases` **UNION** orthodontic cases that have no bridge row. This is a **read model, not a data backfill**: no rows are written for existing orthodontic cases.
  - A bridge row is created only when a user first links an orthodontic case to generic features (referrals, problems).
- **Links** (additive nullable columns; derived joins wherever possible):

  | Link | Column |
  |---|---|
  | Plan item → case | `plan_items.case_id` |
  | Referral → case it serves | `patient_referrals.case_id` |
  | Referral → case it blocks | `patient_referrals.blocks_case_id` |
  | Visit → working context | `visits.case_id` |
  | Lab orders | **derived** via `visit_id` / plan item (no new column) |
  | Invoices | **derived** via `invoice_items.source_id` → `visit_procedures.plan_item_id` → `plan_items.case_id` (no duplicated financial truth) |

### 3.3 Master treatment plan (extend `treatment_plans` / `plan_items`)

- A plan with `specialty IS NULL` = the **master / multidisciplinary plan**. The column is already nullable, so no change is needed.
- `plan_items` additions:
  - `case_id INT NULL`;
  - `priority SMALLINT NULL` (lower = earlier; the display order falls back to `sort_order`).
- The per-item specialty stays `category`, and the per-item responsible provider stays `doctor_id` (both exist).
- **Dependencies** — new table, simple and safe:

  ```
  plan_item_dependencies(
    item_id INT NOT NULL REFERENCES plan_items ON DELETE CASCADE,
    requires_item_id INT NOT NULL REFERENCES plan_items ON DELETE CASCADE,
    requirement TEXT NOT NULL DEFAULT 'completed',   -- completed | clearance
    note TEXT NULL, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_id, requires_item_id), CHECK (item_id <> requires_item_id)
  )
  ```

  - A cycle is refused on insert (a graph walk inside the transaction; the number of items per patient is small).
  - **Evaluation is warn-only.** An unmet dependency shows a blocker in the summary and a warning when the dependent item is added to a visit. Proceeding requires a reason, which is audited as `plan.dependency_override`.
  - There is no automatic scheduling or auto-creation.

### 3.4 Problem list — `patient_problems` (new)

```
patient_problems(id, patient_id, label, site NULL, specialty NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','inactive')),
  case_id NULL, plan_item_id NULL, referral_id NULL,
  noted_by, noted_at, resolved_by NULL, resolved_at NULL)
```

- `patient_diagnoses` is **kept as is**: versioned diagnostic narratives, orthodontic analysis. A problem may reference the diagnosis visit, but does not replace it.

### 3.5 Shared clinical timeline

- `patientTimeline()` gains three things:
  - per-event `specialty`, `doctorName`, `caseId` (derived: visit procedures' categories and doctors; plan item → case);
  - **referral events** (created, accepted, scheduled, completed, returned);
  - a `context` filter (the case or specialty in focus).
- **Permissions:**
  - the existing `canAccessPatient` / money permissions decide what a user may see;
  - financial events stay hidden without money permission;
  - the doctor's **default view is filtered to their case context**, with "show all" one click away.

### 3.6 Patient summary — "What does this patient need next?"

Built from existing sources plus the new ones:
- identity, alerts, allergies, flags;
- active problems;
- active plans and specialty cases (with responsible doctors);
- open internal referrals and **blockers** («⚠️ التقويم بانتظار: علاج عصب 36 — موعد 04/10»);
- pending lab work;
- next appointment;
- balances per currency (permission-gated);
- current visit status.

**Next step** = the first unmet actionable item, ordered by: open referral needing an appointment → blocked item's prerequisite → next planned visit → recall.

### 3.7 Smart specialty context (no new tabs)

- The URL carries context: `/patients/[id]?tab=treatment&case=<id>` or `?tab=today&case=<id>`.
- The context is derived from:
  1. the opening route (referral row, orthodontic schedule, today board);
  2. the visit's appointment → referral → case;
  3. the planned visit → plan item → case.
- «العلاج» sections:
  - Master plan;
  - Specialty cases (Orthodontics / Endo / Perio / Implants / Prostho / …, only those that exist);
  - Internal referrals;
  - Lab;
  - existing sub-tabs kept (chart, orthodontics, referrals, materials).

## 4. Financial and commission implications

- **ONE PATIENT LEDGER.** No per-specialty account. All new columns are clinical links. Invoices and payments are untouched.
- Every financial item keeps its attribution through **existing** keys:
  - patient (`invoices.patient_id`);
  - specialty (`services.category` via the invoice line);
  - case (derived via `source_id` → procedure → plan item → case);
  - work item (`invoice_items.source_id`);
  - treating doctor (`invoice_items.doctor_id`);
  - payment allocation (FIFO per currency bucket, unchanged);
  - commission (the single engine).
- Reports by patient, doctor, specialty, case and service are joins over these keys, never copies.
- **Commission:**
  - the treating doctor is the only key;
  - the coordinating, case-responsible and referring roles earn nothing by role;
  - a "referral fee" policy is **out of scope** (it would need an explicit owner decision and a separate rule in the same engine).
- Installment-funded master plans:
  - BILL-1 (invoiced once);
  - DOCATTR-1 / D1 (installment lines attributed to plan-item doctors by value, so each specialist earns on their own items).

## 5. Required schema changes (all additive, one migration per slice)

| Slice | Change |
|---|---|
| CASE-MODEL-1 | `clinical_cases` (new); `plan_items.case_id`, `plan_items.priority`; `plan_item_dependencies` (new); `patient_problems` (new); `visits.case_id` |
| REF-1 | `patient_referrals` + `kind`, `to_party_id`, `workflow_state`, `case_id`, `blocks_case_id`, `plan_item_id`, `requested_service_id`, `return_to_party_id`, `accepted_*`, `completed_*`, `returned_at`, `procedure_performed`, `followup_required`, `may_return`; `appointments.referral_id` |

- There are no drops, renames or constraint rewrites, and no historical rows are rewritten.
- The schema contract and the ownership test are updated per migration.

## 6. Compatibility

- Existing orthodontic flows, plans, visits, sign, ledger, commission and external referrals behave identically, because every new column is nullable.
- Old API contracts are unchanged; new fields are optional.
- Plans with `specialty` set keep working, and are simply single-specialty plans.

## 7. Delivery order (small PRs, each additive, tested; merged only when gate + CI + review are green)

1. **BILL-1** (P0; R-P0-1 resolved with option A).
2. **DOCATTR-1:** treating doctor per work item (the prerequisite for multispecialty attribution).
3. **CASE-MODEL-1a** (migration 0032): cases, problems, dependencies, item links/priority, `visits.case_id`; API with permissions and audit; «الحالات والمشاكل» under «العلاج».
   **CASE-MODEL-1b:** dependency warning when a dependent item is added to a visit (override with an audited reason), summary "next step", timeline specialty/doctor/case.
4. **REF-1:** internal referrals, the lifecycle, and «حجز الإحالة» → appointment link.
5. **REF-2:** arrival context → specialty workspace; sign-off progress; completion and return-to-referrer; the "My clinical work" view.
6. **CASE-1:** legacy orthodontic baseline plus the orthodontic session inside the sign.
7. **COMM-DETAIL-1:** commission detail with patient, work, specialty and case.
8. Reception readiness / cockpit / checkout slices (per the impact doc).

**Acceptance journey** («محمد أحمد» orthodontics → endodontics → return → prosthodontics suggestion): a PostgreSQL 18 plus HTTP test spanning REF-1 and REF-2, asserting that commission is endodontic-only for Dr Mohammed and that there is one ledger.

## 8. Status (design only)

```
ONE_PATIENT_ONE_RECORD=YES (already true; preserved)
MASTER_MULTISPECIALTY_PLAN=YES after CASE-MODEL-1a (items carry specialty+doctor+case+priority; dependencies warn-only, no cycles)
SPECIALTY_CASE_MODEL=YES after CASE-MODEL-1a (clinical_cases + orthodontic read model/bridge; problem list)
SHARED_CLINICAL_TIMELINE=YES after CASE-MODEL-1b for visits (treating doctor, specialties, case per visit); referral events come with REF-1/REF-2
TREATMENT_DEPENDENCIES_SUPPORTED=YES (1a: plan_item_dependencies; 1b: chair warning, sign requires an audited reason, summary blockers)
COORDINATING_DOCTOR_SEPARATE_FROM_TREATING_DOCTOR=YES in schema / enforced for commission after DOCATTR-1
ONE_PATIENT_LEDGER=YES
SPECIALTY_FINANCIAL_ATTRIBUTION_SAFE=PARTIAL (F-2, F-3 → DOCATTR-1)
SPECIALTY_COMMISSION_ATTRIBUTION_SAFE=PARTIAL (F-2, F-3, F-4 → DOCATTR-1 / COMM-DETAIL-1)
REQUIRES_ARCHITECTURAL_CHANGE=NO
```
