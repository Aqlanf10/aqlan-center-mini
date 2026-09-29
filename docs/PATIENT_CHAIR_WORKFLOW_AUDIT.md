# Patient Chair Workflow — Phase 0 Audit (read-only)

Base: `main` @ `c586b24` (2026-09-29).
Method: code reading plus one PostgreSQL 18 characterization probe (§4.1). The probe was run and not committed.
Scope: the journey `Patient File → Enter Chair → Specialty → Session → Doctor attribution → Sign → Checkout → Next visit → Commission detail`.

Nothing was changed by this audit. The goal is to name what **already exists** (and only needs re-wiring) versus what is **missing**, so that no parallel clinical engine or second commission engine is built.

---

## 1. Verdict

The system already owns most of the pieces. They live in separate places, and a few seams leak money or attribution.

- **Exists and works:**
  - one transactional sign that bills, progresses plan sessions, closes the planned visit and suggests the next;
  - auto lab orders and inventory deduction;
  - per-procedure `doctor_id`;
  - an event-time, per-currency commission engine with lab deduction and a rate history;
  - a checkout panel inside «زيارة اليوم».
- **Leaks (confirmed):**
  - installment plans are billed twice (P0);
  - doctors lose commission when a procedure line carries no doctor (P1);
  - installment revenue earns no commission for anyone (P1);
  - the per-doctor "deduct materials" policy is inert (P1).
- **Missing:**
  - a legacy orthodontic baseline;
  - the orthodontic session inside the sign;
  - a per-line doctor selector;
  - a case-level commission override;
  - line-level commission detail with patient/work/rate explanation;
  - the cockpit header, stepper and specialty router.

---

## 2. Inventory — what exists

| Area | Where | What it does today |
|---|---|---|
| Patient file tabs | `app/patients/[id]/page.tsx` (`TABS`) | الملخص · العلاج (chart/plans/ortho/lab/referrals/materials) · زيارة اليوم · الحساب · الأشعة والملفات. The primary action switches by context («بدء زيارة اليوم» / «استكمال زيارة اليوم» / «تحصيل دفعة» / «حجز الجلسة القادمة»). |
| Enter visit from file | `POST /api/visits` from `page.tsx` and `TodayVisitTab.startManualVisit` | Creates a visit with `patientId`. LIVE-4 prevents a duplicate **active** visit for the same patient. `patientWorkflow().openVisit` keeps an unsigned visit open (VISIT-2). |
| Seat / chair | `seatVisit(id, chair)`, `visits.chair/seated_at/called_at` | Seating is done from Today's Clinic, not from the file. |
| Clinical visit | `components/ClinicalVisit.tsx`, `setVisitProcedures`, `signClinicalVisit` | Complaint, diagnosis, examination, treatment done, next plan, procedures (service/tooth/surfaces/qty/price/`doctorId`/`planItemId`), and «مخطَّط لليوم» from open plan items. |
| **Sign** (steps 1–13 of the prompt) | `signClinicalVisit` (`lib/db.ts` ≈15740) | One transaction under `FOR UPDATE`: validates → re-reads procedures → plan-session pricing (`priceForSession`) → `progressTreatmentSessions` → invoice with `source_type='visit_procedure'` (a unique index blocks double billing) → dental chart → legacy plan-item matching → `closePlannedVisitAndSuggestNext` → `createAutoLabOrders` (unique per visit/tooth) → `deductServiceMaterials` → `signed_at`. Idempotent: a second sign returns `already_signed`. |
| Checkout | `components/patient/TodayVisitTab.tsx` | After sign: pre-sign balances per currency, today's dues in the invoice currency, collection targeted at today's invoice, and the next planned visit. |
| Chairside tablet | `components/ChairsideTabletView.tsx` | Quick procedure phrases / notes / materials for the open visit. It is an input helper, not a workflow. |
| Treatment plans | `treatment_plans` (`specialty`, `primary_doctor_id`, `billing_mode`, consent), `plan_items` (`doctor_id`, `billing_rule`, `session_count`, `billing_status`), `treatment_sessions`, `planned_visits` (`after_days`, `doctor_id`), `plan_installments` | V2 journey: items → sessions → planned visits → appointments. |
| Orthodontics | `ortho_cases` (appliance/arches/slot/bracket/phase/current wires/`plan_id`/`start_date`), `ortho_adjustments` (`visit_id`, wires, elastics, done, `next_weeks`), `components/PatientOrtho.tsx`, `recordAdjustment`, follow-up board, ceph | Case + adjustment log; the current wires are updated in the same transaction as the adjustment. |
| Lab | `lab_orders` (`doctor_id`, `visit_id`, tooth, `cost_minor/cost_currency`, payable) | Auto-created at sign for crown/bridge/veneer work. |
| Inventory | `service_materials` (service → item qty), `inventory_movements` (`visit_id`, `patient_id`) | Deducted at sign. |
| Doctor attribution | `visit_procedures.doctor_id` → `invoice_items.doctor_id` (copied at sign); `visits.doctor_id`; `plan_items.doctor_id`; `treatment_plans.primary_doctor_id`; `patients.primary_doctor_id` | Per-line attribution **exists in the schema**. |
| Commission engine | `lib/commission.ts` | `resolveDoctorEffectivePolicy` resolves custom service → category (in `by_category` mode) → default, as of the event date (`rateHistory`). `commissionForPatientAtEventTime` computes accrued (invoiced) and earned (collected) per doctor × currency, with lab/material deduction per share. |
| Commission data | `doctor_commission_history` (append-only policy timeline), `users.commission_config`, `parties.commission_percent` | Rate changes never rewrite the past (P0-1). |
| Commission report | `commissionReport()` (`lib/db.ts` ≈11797), `/api/finance/commissions`, `/finance/commissions`, report `doctor-commission` (`lib/reports.ts`) | Collections are allocated FIFO per currency bucket, refunds are attached to their origin, and opening balances are consumed first. Lab cost is attributed per (invoice, doctor) and spread over that doctor's lines. A global material-rate estimate (`finance.commission_material_rate`) is applied. **Output: one row per doctor × currency.** |
| Access | `canViewOwnCommissions`, `canViewOtherDoctorsAccounts` (`lib/ai-tools/permission-matrix.ts`, route) | A doctor sees their own figures only when granted; reception gets 403. |
| Attribution for reports | `lib/report-attribution.ts` | The same FIFO/bucket rules, applied to invoice lines, then to doctor/specialty/service. |

---

## 3. Journey map — exists / re-link / missing

| Step | Status | Notes |
|---|---|---|
| Enter chair from the patient file | **Re-link** | The visit is created from the file; seating (chair number) is only on Today's Clinic. Needs «إدخال إلى الكرسي» in the file, reusing `addVisit` (LIVE-4 dedupe) + `seatVisit`. |
| Cockpit header (name, file #, age, primary/visit doctor, chair, time in chair, alerts, allergies, flags, balances per currency) | **Re-link** | All the data exists (`patients.flags/medical_alert`, medical history (PAT-2), `visits.seated_at/chair/doctor_id`, ledger balances). There is no single sticky header. |
| Specialty router | **Missing (UI)** | Sources exist: planned visit → plan `specialty`/item `category` → open `ortho_cases` → appointment `service_id` → last procedure category. Nothing combines them or shows a suggestion. |
| Specialty workspace | **Partial** | Shared fields exist in `ClinicalVisit`. Orthodontics has its own tab (`PatientOrtho`), outside the visit. |
| Legacy ortho baseline | **Missing** | `createOrthoCase` accepts a past `start_date` but not current wires/phase/elastics/responsible doctor/financial arrangement, and has no "baseline" marker. |
| Ortho chair session | **Partial** | `recordAdjustment` exists, but runs in a **separate transaction** from the sign, with optional `visit_id` and no uniqueness (F-6). |
| Treating doctor per work item | **Partial** | `visit_procedures.doctor_id` exists. The UI copies the visit doctor into a line only at the moment the line is added; there is no per-line selector; the server does not default or freeze it (F-2). |
| Multiple doctors per case | **Schema yes / UI no** | Lines can carry different doctors; the lab deduction is already per (invoice, doctor). |
| Commission rate priority | **Partial** | Service → category → default exists. **No case override** (F-11). Name matching is fuzzy (F-5). |
| Commission detail / explanation | **Missing** | The engine computes per share internally but only returns totals (F-8). |
| Lab cost attribution | **Mostly safe** | `lab_orders.doctor_id` (else visit doctor) → that doctor's lines on the visit invoice. A lab order without a `visit_id` is never deducted (it is not counted as "not deducted" either — see §4.9). |
| Material cost attribution | **Unsafe** | The per-doctor `deductMaterialCost` is inert (F-4); only a global category-rate estimate applies. |
| Billing rule at session end | **Partial / unsafe** | `on_start / on_completion / per_session` work. `package` is accepted by the API but priced as `per_session` (F-7). The plan's `billing_mode` is ignored at sign → double billing (F-1). There is no NO_CHARGE with a reason. |
| Sign orchestration + idempotency | **Exists** | See §2. The orthodontic adjustment is the only side-effect outside it. |
| Checkout inside the file | **Exists (partial)** | Balances, today's dues and collection are there. Missing: an explicit "included / no charge / defer" choice, and the next-visit booking inline (it only suggests the planned visit). |
| Session → commission trace | **Derivable** | Patient → visit (`visits.invoice_id`) → `invoice_items.source_id` = `visit_procedures.id` → `doctor_id` → policy at event time. Only the report output is missing. |
| Refunds / corrections | **Exists** | Refunds reduce their origin (FIFO/LIFO rules); invoice correction (FIN-2) and receipt correction (RC-1/2) flow through the same engine. |
| Multi-currency | **Exists** | Every step is bucketed per currency; nothing nets currencies. |

---

## 4. Confirmed defects

### 4.1 F-1 — P0 — Installment plans are billed twice

Probe on PostgreSQL 18:
- `createPlanV2` with `billingMode: "installments"`: item «تقويم ثابت» 300,000 YER, `per_session`, 3 sessions, plus 2 installments of 150,000.
- Consent, then collect installment 1, then sign a visit with the linked procedure.

Result:

| Invoice | Total | Source |
|---|---|---|
| #1 | 150,000 | `recordPlanInstallment` («عقد تقويم — قسط 1») |
| #2 | 100,000 | `signClinicalVisit` («تقويم ثابت (جلسة 1 من 3)») |

- The installments invoice the agreement, and signing **also** invoices each session of the same agreement.
- After all installments and sessions, the patient is billed 600,000 for a 300,000 contract.
- Root cause: `treatment_plans.billing_mode` is written by `createPlanV2` and read **nowhere**. `signClinicalVisit` prices every linked item by its `billing_rule` alone.

**Fix direction:** at sign, a session of an item whose plan is funded by installments or a custom schedule is **INCLUDED**. The session progresses and is recorded; the line is priced 0 and marked included. No new invoice is created.

**Data:** production may already hold such plans. The fix must not rewrite them. A read-only detection query or report is proposed for the owner to review, with correction through FIN-2 (invoice correction) only.

### 4.2 F-2 — P1 — A procedure line without a doctor loses its commission silently

- In the probe, the visit had a doctor but the procedure line had `doctor_id = NULL`.
- The invoice line was copied with `NULL`, and `commissionReport` returned `[]`.
- The UI copies `doctorId` into a draft line **when the line is added**. A line added before the doctor is chosen, or entered from another path, stays `NULL`.
- The server neither defaults nor freezes the doctor at sign.

**Fix direction:**
- At sign, a line with no doctor takes the visit doctor, and the attribution is frozen on the invoice line.
- If neither exists, the sign is refused with an Arabic message; no ownerless line is billed.
- Add a per-line doctor selector (default: the visit doctor or the signed-in doctor).
- A change after sign is an admin correction with a reason and an audit record.

### 4.3 F-3 — P1 — Installment revenue earns no commission

- `recordPlanInstallment` inserts `invoice_items (description, qty, price)` with **no `doctor_id`, `service_id` or category**.
- The engine only pays doctor shares, so collections on orthodontic contracts, which are usually installment plans, produce no commission for the orthodontist.

**Fix direction:** attribute installment invoice lines by the plan's items (by doctor and category, proportionally to item value), falling back to `treatment_plans.primary_doctor_id` and the plan specialty. This needs an **owner decision (D1)**.

### 4.4 F-4 — P1 — The per-doctor «خصم تكلفة المواد» is inert

- `DoctorShareItem.materialCostMinor` is never populated by `commissionReport`, so `deductMaterialCost = true` changes nothing.
- The only material deduction is the global category-rate estimate (`finance.commission_material_rate`).

**Fix direction:** populate `materialCostMinor` per share from `inventory_movements` for that visit, costed at `unit_cost_minor`. When a movement cannot be tied to one doctor's line, report it as **unallocated**; never guess.

### 4.5 F-5 — P2 — Custom service rate matched by fuzzy name

- `resolveDoctorEffectivePolicy` matches `csr.serviceName` with `includes` in both directions.
- Example: a 45% rule for «زراعة» also matches «إزالة زراعة».

**Fix direction:** match by `serviceId` when it exists; use an exact normalized name only for legacy rules.

### 4.6 F-6 — P2 — Orthodontic adjustment outside the sign, not idempotent

- `recordAdjustment` runs its own transaction, with `visit_id` optional.
- A double click records two adjustments.
- It is not tied to the visit invoice or billing rule.

**Fix direction:**
- The orthodontic session becomes part of the visit (saved with the visit draft, committed by the sign).
- Add a partial unique index `(case_id, visit_id) WHERE visit_id IS NOT NULL`.

### 4.7 F-7 — P2 — `package` billing rule half-implemented

- The API accepts `package`, but `lib/workflow.ts` prices it as `per_session`.
- `plan_items.billing_status` (`included_in_package`, `waived`) is never written.

**Fix direction:** superseded by F-1 (INCLUDED at the plan level) plus a NO_CHARGE reason at the line level.

### 4.8 F-8 — P2 — Commission output is totals only

- `commissionReport`, `/finance/commissions` and the `doctor-commission` statement show one row per doctor × currency.
- There is no patient, work, invoice, collection, rate or rate-source detail.

**Fix direction:** the same engine gains an optional **detail sink** that records, for each share it already computes: patient, invoice, line, service, category, base, lab, materials, percent, rule source, accrued and earned. This is not a second engine.

### 4.9 Notes (no defect)

- **Lab orders without `visit_id`** (created manually from the lab screen) are never deducted from commission. The report does not list them as "not deducted".
  - Proposed: count them in `labCostNotDeductedCount` so they are seen.
- **Commission policy is event-time**, so history is never rewritten by a rate change. Keep this.

### 4.10 F-11 — Missing — Case-level commission override

There is nowhere to store «٢٥٪ لحالة محمد أحمد لدى د. يوسف». Proposed in §5.

---

## 5. Minimal additive schema (proposed; no table is created in Phase 0)

| Need | Proposal | Why not an existing table |
|---|---|---|
| Legacy orthodontic baseline | `ortho_cases` + `baseline_kind TEXT NULL` ('legacy'), `baseline_recorded_at`, `elastics TEXT`, `responsible_doctor_id INT REFERENCES parties`, `legacy_financial_mode TEXT` (`opening_balance` / `prepaid_included` / `per_session` / `installments`), `remaining_objectives TEXT` | The case table already is the orthodontic case. |
| One orthodontic session per visit | Partial unique index `ortho_adjustments (case_id, visit_id) WHERE visit_id IS NOT NULL` | Existing rows have one row per visit. |
| Case commission override | New append-only `commission_case_overrides` (`id`, `doctor_id`, `plan_id` NULL, `ortho_case_id` NULL, `percent`, `reason NOT NULL`, `effective_from`, `created_by`, `created_at`, `voided_at/by/reason`) | A per-case rule is neither a doctor policy nor a plan field; append-only keeps the history. |
| Session billing decision | `visit_procedures` + `billing_decision TEXT NULL` (`bill_now` / `plan_progress` / `included` / `no_charge`), `billing_reason TEXT NULL` | This is where the price of the line is decided; the invoice line keeps `source_id`. |
| Specialty case | **No new table.** A case = a `treatment_plans` row (`specialty`, `primary_doctor_id`), plus `ortho_cases` for orthodontics. | A generic `specialty_cases` table would duplicate plans. Re-evaluate only if a non-plan case needs to exist. |
| Work item | **No new table.** `visit_procedures` is the work item (service, tooth, `doctor_id`, `plan_item_id`, price) and `invoice_items.source_id` points to it. | Already one row per billable piece of work. |

All changes are additive (`ADD COLUMN IF NOT EXISTS`, new table, new index). No deletes, no rewrites, no fake history.

---

## 6. Proposed PR sequence

A minimum logical split. Each PR is focused, migration-safe, independently reviewable, and **not merged without the owner**.

1. **BILL-1 (P0):** installment/custom-schedule plans are not re-billed at sign (INCLUDED).
   - Sessions still progress.
   - Line price 0 with an "included" marker.
   - Includes the NO_CHARGE decision with a mandatory reason.
   - Adds a read-only detection report of already double-billed plans.
   - Tests: the F-1 repro plus prompt Scenario B.
2. **DOCATTR-1:** treating doctor per work item.
   - Server default to the visit doctor at sign, and freeze.
   - Refuse a line with no owner.
   - Per-line selector with a "+ طبيب معالج" UX.
   - Admin-only change after sign, with reason and audit.
   - Installment lines attributed by plan items or the primary doctor (after D1).
   - Tests: F-2, F-3, Scenario E.
3. **COMM-DETAIL-1:** the same engine emits line detail.
   - Rate source label (case override → service → category → default).
   - Case override table plus admin UI (reason, audit).
   - Material cost per share from inventory (F-4); exact service matching (F-5).
   - Detail table, drill-down, filters and printable statement.
   - Doctor privacy.
   - Tests: Scenarios C, D, F, G, H, I plus a performance check (batch queries only).
4. **CASE-1:** legacy orthodontic baseline plus the orthodontic session inside the visit sign (idempotent).
   - Uses the legacy financial modes, with no fake invoices.
   - Tests: Scenario A plus a double-click test.
5. **CHAIR-1:** patient-file cockpit.
   - Sticky header, «إدخال إلى الكرسي» (reuse visit plus seat), stepper, specialty router (suggest, never auto-switch).
   - Checkout completion: included / no-charge / defer, next-visit booking inline.
   - UI over the pieces above; no new engine.

The order is money first (P0/P1 leaks), then explanation, then the cockpit that sits on top.

---

## 7. Owner decisions needed

- **D1 — who earns on installment collections?**
  - Recommended: split by the plan items' doctors in proportion to item value, falling back to the plan's primary doctor.
  - Alternative: always the plan's primary doctor.
- **D2 — installment plan sessions:** confirm that a session of an installment-funded plan is **INCLUDED** (no invoice at sign) and the money is collected by the installment schedule only.
- **D3 — existing double-billed plans (F-1):** review them from a read-only report and correct them one by one with FIN-2 (invoice correction). The system must not auto-correct.

---

## 8. Phase 0 status

```
PATIENT_FILE_IS_CLINICAL_COCKPIT=NO
CHAIR_FLOW_COMPLETE=NO
SPECIALTY_ROUTING_COMPLETE=NO
LEGACY_ORTHO_BASELINE_SUPPORTED=NO
ORTHO_SESSION_FROM_PATIENT_FILE=NO (separate tab, separate transaction)
TREATING_DOCTOR_PER_WORK_ITEM=NO (schema yes; UI default stale, no server default — F-2)
MULTIPLE_DOCTORS_PER_CASE_SAFE=NO (schema yes; no per-line selector)
CASE_COMMISSION_OVERRIDE_SUPPORTED=NO
COMMISSION_ENGINE_REUSED=YES (single engine; to be extended, not duplicated)
COMMISSION_PATIENT_DETAIL_VISIBLE=NO
COMMISSION_WORK_DETAIL_VISIBLE=NO
COMMISSION_RATE_EXPLAINED=NO
LAB_COST_ATTRIBUTION_SAFE=YES (per invoice+doctor; visit-less lab orders not surfaced — §4.9)
MATERIAL_COST_ATTRIBUTION_SAFE=NO (F-4)
CHECKOUT_FROM_PATIENT_FILE=PARTIAL
SINGLE_SESSION_BILLING_SAFE=YES
MULTI_SESSION_PLAN_SAFE=NO (F-1)
INCLUDED_SESSION_SAFE=NO (F-1, F-7)
NEXT_VISIT_SCHEDULED_FROM_CHECKOUT=PARTIAL (suggested, booked elsewhere)
MULTI_CURRENCY_SAFE=YES
P0_OPEN=1 (F-1)
P1_OPEN=3 (F-2, F-3, F-4)
P2_OPEN=4 (F-5, F-6, F-7, F-8)
```
