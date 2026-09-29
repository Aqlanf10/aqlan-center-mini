# Reception → Checkout — Change Impact and Preservation Gate

Date: 2026-09-29.
Base: `main` @ `c586b24`.
Inputs:
- `PATIENT_CHAIR_WORKFLOW_AUDIT.md` (internal audit, findings F-1…F-8);
- `DENTAL_PMS_WORKFLOW_BENCHMARK.md` (external rules BR-1…BR-7).

This document is the gate **before** any implementation. A slice starts only when its P0 risks are resolved.

---

## 1. Preservation gate — what already exists

| Feature | EXISTS_ALREADY | UI today | API | Domain function | DB source of truth | Audit | Reports | Financial downstream |
|---|---|---|---|---|---|---|---|---|
| Appointment arrival | **YES** | Today board / appointments «وصل» | `/api/appointments/[id]` | `arriveAppointment()` (reuses or attaches the visit, LIVE-4) | `appointments.status/arrived_at`, `visits` | `appointment_status_log` | Appointments, performance | none |
| Walk-in | **YES** | Today board, patient file «بدء زيارة» | `POST /api/visits` | `addVisit()` (+ `ActiveVisitExists`) | `visits` | LIVE-3 actor audit | Visits report | none |
| Self / portal check-in | **YES** | QR page, portal | `/api/checkin`, `/api/portal/*` | `addVisit` / `arriveAppointment` + `createIntakeForm` | `visits`, `patient_intake_forms` | `recordAudit` | — | none |
| Waiting room / queue / TV | **YES** | Today board, display app | `/api/visits/[id]` (call/seat/return/finish) | `callVisit`, `seatVisit`, `returnVisitToWaiting`, `finishVisit` | `visits.status` (`waiting/called/in_chair/done`), `called_at/seated_at/finished_at` | LIVE-3 | Visits, chair utilization | none |
| Reception readiness / clearance | **PARTIAL** | Alerts/flags in the patient file; intake exists | — | — | `patients.flags/medical_alert`, medical history, intake forms | — | — | none |
| Previous balance at reception | **PARTIAL** | Patient file, checkout snapshot | `/api/patients/[id]/ledger` | `patientLedger` + `ledgerBalancesByCurrency` | invoices, payments, openings | — | Debt, aging | read-only |
| Prepayment / consultation fee | **YES** (on-account or plan payment; the consultation service is billed at sign) | Collect modal (`CollectPaymentModal`) | `POST /api/payments` | `recordPayment()` | `payments` (append-only) | `payment.create` | Collections | FIFO allocation to invoices; journal Dr Cash / Cr AR |
| Ready-for-chair signal | **NO** (only `called`) | — | — | — | — | — | — | — |
| Clinical cockpit | **PARTIAL** | «زيارة اليوم» + `ClinicalVisit` + chairside + orthodontic tab | `/api/visits/[id]/clinical` | `getClinicalVisit`, `setVisitProcedures`, `saveClinicalNotes` | `visits`, `visit_procedures` | price overrides audited | — | none until sign |
| Sign-off | **YES** | `ClinicalVisit` «توقيع» | `/api/visits/[id]/clinical` (sign) | `signClinicalVisit()` | invoices/items (`source_type/source_id` unique), sessions, planned visits, lab orders, inventory | visit sign, overrides | All financial reports | invoice → AR, commission |
| Checkout | **PARTIAL** | `TodayVisitTab` checkout panel | payments, plans installments | `recordPayment`, `recordPlanInstallment` | payments | yes | Collections | FIFO, commission earned |
| Installment collection | **YES — two paths** | Plans: «سجّل القسط» / Collect modal: plan target | `/api/plans/[id]/installments`, `POST /api/payments` (`planId`) | `recordPlanInstallment()` (**invoice + payment**), `recordPayment(planId)` (**payment only**) | invoices (`plan_id`), payments | yes | Plans, collections | **see R-P0-1** |
| Next appointment | **PARTIAL** | Planned visits; reception books elsewhere | appointments API | `closePlannedVisitAndSuggestNext`, booking | `planned_visits`, `appointments` | status log | Unscheduled treatment | none |
| Doctor attribution | **PARTIAL** | Visit doctor; no per-line selector | clinical API | `setVisitProcedures` / `signClinicalVisit` | `visit_procedures.doctor_id` → `invoice_items.doctor_id` | — | Doctor, specialty | commission |
| Commission | **YES (engine) / NO (detail)** | `/finance/commissions`, `doctor-commission` report | `/api/finance/commissions` | `commissionReport()` + `lib/commission.ts` | invoices, payments, lab orders, `doctor_commission_history` | policy changes | Doctor reports | payouts (expenses `commission`) |
| Corrections | **YES** | Invoice/receipt correction, addendum | `/api/invoices/[id]/correct`, `/api/payments/[id]/correct` | `correctInvoice`, `correctPayment`, `addVisitAddendum` | append-only | sensitive audit | all | reversal semantics |

**Rule.** Every slice below extends these functions. None of them is replaced.

---

## 2. Open P0 risk — must be resolved before BILL-1 is implemented

### R-P0-1 — Two installment-collection paths make "sessions INCLUDED" unsafe on its own

**Facts (verified on `main`):**
- «سجّل القسط واطبع السند» → `recordPlanInstallment()` → creates an **installment invoice** (`invoices.plan_id`) plus a payment.
- The Collect modal with **plan target** → `recordPayment({ planId })` → creates a **payment only** (no invoice). It settles the plan's currency bucket and waits for invoices to be allocated FIFO.
- Today, signing a plan session always invoices it (F-1).
  - Path 1 users are therefore **double billed** (confirmed on PG18).
  - Path 2 users are billed **correctly**, because the session invoices are the plan's only invoices.

**Why this is P0:** if BILL-1 simply made installment-plan sessions INCLUDED (price 0, no invoice), then for path-2 users the plan would **never be invoiced**:
- payments would sit as patient credit;
- revenue (4101) would never be recognized;
- the doctor's commission would be 0.

That swaps a double billing for missing billing.

**Options for the owner:**

| Option | Rule | Pros | Cons |
|---|---|---|---|
| **A** (recommended) | Sessions of an installment-funded plan are INCLUDED **only while the plan's agreement is invoiced by installment invoices**. The Collect modal, when a plan with installments is chosen, uses the same installment path (invoice + payment for the next due installment) instead of a bare plan payment. Old plan-target payments stay as they are. | One revenue source per agreement (BR-2, as in Denticon and Open Dental). The schedule drives dues, per D2. The staff path no longer matters. | Changes what the Collect modal does for installment plans (UI plus a server-side bridge; the API input stays compatible). |
| **B** | **Agreement ceiling:** never invoice a plan beyond its agreed total, whichever path invoices first. Session and installment invoices are both capped at `plan total − already invoiced for the plan`. | Path-independent; no double billing and no missing billing. No change to the collect paths. | With the installment button, a session can create dues *before* the next installment date. This departs from D2's "collected by schedule only". |
| **C** | Keep today's behaviour and only add the detection report. | Zero behaviour change. | The double billing continues for path-1 users. |

**Status: RESOLVED — owner chose option A** (staff collect with «سجّل القسط»; «القسط وحده يفوتر»).
- Implemented in BILL-1 (branch `fix/installment-plan-included`):
  - `POST /api/payments` with `planId` on an installment-funded plan (`billing_mode` installments/custom_schedule, or any `plan_installments` row) is bridged to `recordPlanInstallment()` → installment invoice + payment. The API input is unchanged.
  - Per-procedure plans without installments keep the bare plan payment (unchanged).
  - Sessions of installment-funded plans are INCLUDED (price 0, no invoice, `billing_status='included_in_package'`).
  - Historical rows are untouched. The read-only report «جلسات خطط أقساط فُوترت مرتين» lists old double-billed sessions and old plan payments without an installment invoice, for manual FIN-2 review.
- `P0_OPEN=0`.
---

## 3. Impact per slice (small PRs, in order)

Every slice:
- starts from the latest `main`;
- uses additive migrations only;
- runs PG18 (plus HTTP where needed) regression tests **before** and after;
- keeps the production build and CI green;
- is merged only when the full gate, CI and review are green (owner instruction: merge ready branches).

### Slice 0 — BILL-1 (P0 billing fix) — R-P0-1 decided: option A

- **Tables:**
  - `plan_items.billing_status` (existing column, now written: `included_in_package`);
  - `visit_procedures.unit_price_minor` (0 for included);
  - `invoices`/`invoice_items` (fewer rows for included sessions).
  - Option A also touches `invoices.plan_id` rows from the collect path.
- **APIs:**
  - `/api/visits/[id]/clinical` (save / sign) — same contract; the `duesMinor`/`invoiceId` values change for included sessions;
  - Option A: `POST /api/payments` with `planId` on an installment plan (compatibility bridge).
- **Flows affected:**
  - sign;
  - «مخطَّط لليوم» price display;
  - checkout (dues 0 for included sessions);
  - the plan screen label «مشمول في الباقة».
- **Backward compatibility:**
  - no stored data is changed;
  - old double-billed invoices stay as they are and are listed in the read-only report «جلسات خطط أقساط فُوترت مرتين» for manual FIN-2 correction (owner D3).
- **Migration risk:** none (no schema change).
- **Financial risk:** R-P0-1, resolved by option A (above).
  - After the fix: installment plan revenue = installment invoices only.
  - Commission for installment plans was already 0 (F-3), so there is no numeric regression; DOCATTR-1 fixes attribution.
- **Clinical risk:** none. Sessions still progress, and chart, lab and inventory run as before.
- **Reporting impact:**
  - revenue per period for installment plans moves from session dates to installment dates, which is the intended D2;
  - procedure counts are unchanged (read from `visit_procedures`).
- **Permissions:** the report is admin and accountant only.
- **Rollback (code level):** revert the commit. No schema change, so nothing to undo in the database. Included sessions signed meanwhile have price-0 procedure rows and no invoice; the report lists them for FIN-2 re-billing if needed.

### Slice 1 — Reception readiness model

- **Tables:** `visits` + `cleared_at TIMESTAMPTZ NULL`, `cleared_by TEXT NULL` (additive). Checklist items are **derived** from:
  - medical history (reviewed or not);
  - `patients.medical_alert/flags`;
  - intake completion;
  - an optional finance note.
- **APIs:** `/api/visits/[id]` gains a `clear` action (new action value; existing actions unchanged).
- **Flows affected:** Today board (badge), patient file header.
  - **No** change to `visits.status` values: the TV display, reports and tests keep the same meaning.
- **Backward compatibility:** `NULL` = not acknowledged, which is treated exactly as today.
- **Risks:**
  - Financial: none.
  - Clinical: positive (alerts acknowledged before seating).
- **Rollback:** columns unused if reverted.

### Slice 2 — Pre-chair financial clearance (information, not a block)

- **Tables:** none. Uses the existing ledger per currency.
- **Settings:** `reception.balance_warning_minor` (per currency, default off).
- **Flows affected:** arrival row / patient header show the per-currency balance to roles with money view.
- **Must not:** block treatment by a rigid rule (owner rule), or convert a prepayment into revenue (BR-1: prepayment stays AR credit until invoiced).
- **Permissions:** doctors only with `canViewPatientPayments`; reception per the existing money roles.

### Slice 3 — Ready-for-chair gate

- **Tables:** none beyond Slice 1.
- **Settings:** `ops.require_clearance_before_call` (default **off** = warn only).
- **Flows affected:** `callVisit`/`seatVisit` return a warning. They refuse only when the Setting is on, and emergencies can bypass with a reason (audited).
- **Risk:** crowding. It must not slow the busy desk, so warn-only is the default.

### Slice 4 — Patient clinical cockpit (UI)

- **Tables and APIs:** none new. It composes `TodayVisitTab`, `ClinicalVisit`, the orthodontic summary, balances, alerts and chair/time data.
- **Risk:** UI only. The regression suite covers the existing flows unchanged.

### Slice 5 — Sign-off → checkout

- **Tables:** none new for "no charge": it uses the existing price override with a mandatory reason (P1-6 authority, audited).
- **Flows added:**
  - "included" (from Slice 0);
  - "defer" (no payment; the balance stays);
  - a printable walkout from existing data;
  - inline next-appointment booking reusing the booking API.
- **Risk:** low. The orchestration stays inside `signClinicalVisit` (idempotent).

### Slice 6 — Doctor attribution and commission detail

- **Tables:**
  - `invoice_items.doctor_id` filled at sign (default: the visit doctor);
  - installment invoice lines attributed to plan-item doctors by value (D1), falling back to the primary doctor;
  - new append-only `commission_case_overrides` (admin, reason, audit).
- **APIs:** `/api/finance/commissions` gains a detail mode; a new printable doctor statement.
- **Engine:** `lib/commission.ts` / `commissionReport` gain a **detail sink**. There is no second engine, and existing totals must be identical for unaffected cases (a regression test pins current numbers).
- **Financial risk:** attribution changes future installment lines only. Historical invoice lines are **not** rewritten, and old periods are not re-rated (event-time policy).
- **Permissions:** doctors see only their own detail (`canViewOwnCommissions`); reception never; admin and accountant all.

### Slice 7 — Reports and printing

- Extends the existing report center (`buildReport`, registry, access matrix). No parallel report engine.

---

## 4. Baseline regression required before any slice

The existing suites must stay green, and each slice adds its own:
- appointment and walk-in flows (`duplicate-active-visit`, `visit-*`, arrivals);
- ledger (`p01-*`, `td05-*`, `financial-reconciliation-scenarios`);
- checkout and plans (`plan-installment-idempotency`, `template-session-order`, `next-visit-date`);
- orthodontics;
- commissions (`doctor-commission-engine`, `commission-refund-aware`, `p01-commission-currency`);
- reports.

**Known intentional numeric change (BILL-1):**
- `td05-currency-persistence` asserted a USD balance built from an installment plan billed twice ($1,500 contract billed $2,000).
- The test is re-pointed to a per-procedure plan (the same currency rule is proven) and keeps identical balance numbers.
- It is documented in the PR.

## 5. Status

```
REQUIRES_ARCHITECTURAL_CHANGE=NO (for slices 0–7 as designed)
REQUIRES_ARCHITECTURAL_CHANGE=YES only for per-procedure hidden prepayment splits (deferred, not needed)
P0_OPEN=0 (R-P0-1 resolved — option A, implemented in BILL-1)
IMPLEMENTATION_STARTED=YES (BILL-1 only; later slices follow docs/MULTISPECIALTY_PATIENT_ARCHITECTURE.md §delivery order)
```
