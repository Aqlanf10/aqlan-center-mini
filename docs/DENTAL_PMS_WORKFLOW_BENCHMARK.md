# Dental PMS Workflow Benchmark — Reception → Chair → Checkout → Commission

Date: 2026-09-29.
Base: `main` @ `c586b24`.
Companion docs: `PATIENT_CHAIR_WORKFLOW_AUDIT.md` (internal audit) and `RECEPTION_TO_CHECKOUT_CHANGE_IMPACT.md` (impact and safety).

**Purpose.** Extract the *business rule* behind each mechanism in mature dental PMSs and decide whether AQLAN CENTER MINI already covers it, needs only re-linking, or needs a change. This is **not** a mandate to copy another product's workflow. The priorities, in order:

1. data safety;
2. one source of truth;
3. no duplicate engines;
4. backward compatibility;
5. additive migrations;
6. regression tests first.

## Sources and how much weight they carry

| System | Source quality | Used for |
|---|---|---|
| **Open Dental** | Official manual and official API/schema pages, which describe the open-source codebase. **Primary reference.** | Arrival/seat/dismiss timestamps, waiting room, prepayments (unearned income), payment plans vs production, Ortho Case (including transfer cases), set-complete provider, procedure lock/invalidate, audit trail, planned appointments, walkout statement |
| **Denticon (Planet DDS)** | Official support knowledge base | Reception → operatory → checkout timestamps, walkout report, orthodontic payment-plan contract, provider production/collection reporting |
| **CareStack** | Official Zendesk help center (some pages returned 403) plus official feature pages | Kiosk check-in, treatment-plan phases, unapplied credits, partial checkout of a plan |
| **Curve Dental** | Official blog (vendor source, but marketing-style) | "Cleared" check-in status pushed to the clinical side |
| **Dentrix / Dentrix Ascend** | Official Dentrix Magazine and Ascend support/learn pages (one page returned 503) | Payment allocation: split by performing provider vs the patient's primary provider; orthodontic future-due payment plans |
| **Open source (GitHub)** | Repositories found: LibreDental, OpenDentist, DentalPin, DentneD, OpenMolar2, and ODental (a fork of Open Dental) | Only confirm that the Open Dental data model is the reference open implementation. The newer projects are young and not used as authority. |

Where only marketing material existed (Curve, parts of CareStack), the mechanism is marked **(vendor claim)** and no design decision rests on it alone.

---

## Benchmark table

Legend for **Ours today**:
- **E** = exists and works;
- **P** = partial;
- **N** = missing;
- **R** = exists but needs re-linking.

| # | Capability | AQLAN CENTER MINI today | Open Dental | Denticon | CareStack | Curve / Dentrix | Recommended design |
|---|---|---|---|---|---|---|---|
| 1 | **Arrival / check-in** | **E**. `arriveAppointment()` sets the appointment to `arrived` and reuses or attaches the visit (LIVE-4 dedupe). There are walk-ins (`addVisit`), QR self check-in (`/api/checkin`: complaint, medical screen, ticket), and portal appointments. | The appointment's Confirmed status triggers `DateTimeArrived`; there is eClipboard self check-in. | Timestamps: in reception → available → in operatory → checked out. | Kiosk check-in updates the appointment and notifies staff. | Curve: forms before arrival; check-in becomes verification. | **Keep.** No new check-in function. Surface the pre-arrival intake completion (`/api/checkin` data) on the arrival row. |
| 2 | **Reception readiness / clearance** | **P**. Medical alerts, flags and intake exist per patient, but no "cleared" signal is shown to the clinical side. | Waiting room (arrived, not seated) plus alerts; readiness is implicit. | An "available" status between reception and operatory. | Statuses are configurable. | **Curve (vendor claim):** "when a patient checks in and all items are cleared, that status pushes to the clinical side automatically." | **Add a derived readiness checklist** (medical history reviewed, alerts acknowledged, intake done, financial note acknowledged) plus one additive `cleared_at/by` acknowledgement. **No new visit status value** (see item 6). |
| 3 | **Previous balance handling** | **P**. The per-currency balance is shown in the patient file and at checkout (the pre-sign snapshot). The Today board shows no balance. | Account module; walkout statement for the day. | Automated balance campaigns, walkout. | Unapplied-credit management. | Dentrix: allocate balances per provider. | Show the per-currency balance on arrival **as information, never as a hard block**. An optional, configurable warning (Settings) only. The prompt forbids a rigid rule that blocks treatment. |
| 4 | **Consultation fee / prepayment before treatment** | **P**. A consultation service is billed at sign. Payment "على الحساب" or on a plan (`plan_id`) is possible before treatment; it reduces the bucket due and is allocated FIFO to invoices when they exist. | **Prepayment = unearned income, not production.** It can be allocated to treatment-planned procedures as *hidden splits* and becomes income when the procedure is set complete. | The orthodontic contract takes the down payment through the contract. | "Accept payments in advance of the treatment or apply the plan to completed treatments"; unapplied credits. | Dentrix: future-due orthodontic payment plans with a down payment. | **Our rule already matches the principle.** A payment with no invoice books Dr Cash / Cr AR, so revenue (4101) is recognized only when the invoice is issued, and commission applies only to invoice coverage (FIFO). **Do not** build per-procedure hidden splits (`REQUIRES_ARCHITECTURAL_CHANGE=YES`, not needed). Optional later: a "prepayment for consultation" shortcut that uses the existing `recordPayment` on account. |
| 5 | **Waiting room** | **E**. Visits `waiting → called → in_chair → done`, TV display, call/call-again, audit (LIVE-3), late arrivals list (`lib/arrivals.ts`). | The waiting room lists patients with Time Arrived and no Time Seated, with long-wait alerts. | The time-stamps report computes wait and operatory time. | Configurable statuses, kiosk. | — | **Keep.** Possibly add a wait-time alert threshold from Settings (the Open Dental pattern). |
| 6 | **Ready for chair** | **P**. `called` means the assistant called the patient to a chair. There is no "cleared/ready" state before calling. | Implicit: seated via the status trigger. | Explicit "available" between reception and operatory. | Configurable status. | Curve: the cleared status reaches the clinical side. | **Do not change the meaning of `visits.status`** (used by the TV display, board, reports and tests). Readiness = the derived checklist from item 2 plus `cleared_at`. The board shows a "جاهز للكرسي" badge. Calling stays allowed without it (warn, don't block), unless the owner enables a Setting. |
| 7 | **Operatory / in-chair workflow** | **P**. `ClinicalVisit`, the chairside tablet and the orthodontic tab are separate surfaces; there is no single cockpit header. | Chart module for the seated patient; procedures are set complete from the appointment. | In-operatory status plus clinical charting. | Clinical module. | Curve: integrated clinical flow. | **Re-link:** «زيارة اليوم» becomes the cockpit (header, stepper) over the existing components. There is no second workspace. |
| 8 | **Clinical documentation** | **E**. Complaint/exam/diagnosis/treatment done/next plan, quick phrases, addendum after sign (append-only), signature. | Procedure notes; after completion, edits are audited. The lock tool allows only **append or invalidate**. | Clinical notes. | Clinical notes. | — | **Keep.** Our addendum is already the "append" model. |
| 9 | **Treatment plan / multi-session** | **E/P**. Plans → items → sessions → planned visits; the billing rule is per item. **Defect F-1:** an installment-funded plan is billed twice. | **Payment plan vs production are distinct.** Production is recognized at procedure completion; PayPlan charges are separate line items. Treatment-planned procedures enter the schedule only once complete ("Await procedure completion"), or are added as PayPlan production when set complete. **Ortho Case:** the fee is split into banding / per-visit / debond; the per-visit amount is recognized as each visit is set complete. | **The orthodontic payment-plan contract is recommended over charging the full amount**; charges are posted from the contract schedule. | Phases; partial checkout charges only completed procedures. | Dentrix Ascend: future-due orthodontic payment plans. | **One source of revenue per agreement.** For an installment-funded plan, the **contract schedule** issues the invoices; sessions are **INCLUDED** (owner D2). This is the Denticon model and the "PayPlan charge is the ledger line" rule in Open Dental. Per-procedure plans keep per-session billing. This is **BILL-1**. |
| 10 | **Checkout** | **E/P**. Checkout panel in «زيارة اليوم»: per-currency balance before sign, today's dues, collection targeted at today's invoice, next planned visit. | Set Complete, then Walkout statement (today's procedures and payments). | Walkout report including the next appointment. | Partial plan checkout. | Curve: a walkout statement recaps the visit. | **Keep and extend:** add explicit "included / no charge (with reason) / defer" outcomes and a printable walkout (today's work, payments, next appointment) from existing data. |
| 11 | **Applying prepayments after services complete** | **E (automatic).** Collections are allocated FIFO per currency bucket: opening balance first, then invoices oldest first. Plan-targeted payments settle the plan's currency bucket. | Hidden splits auto-transfer at completion, or manual "Allocate Unearned". | Contract. | Unapplied credits can be applied manually. | — | **Keep automatic FIFO** (it is the single allocation rule already shared by the ledger, reports and commissions). Do **not** add a second manual allocation engine. |
| 12 | **Doctor / provider attribution** | **P**. `visit_procedures.doctor_id` → `invoice_items.doctor_id`. **F-2:** a line without a doctor is not defaulted or frozen at sign. **F-3:** installment invoice lines carry no doctor. | **Each procedure has a treating provider** ("Prov: Treating provider"), assigned from the appointment at set-complete. The API, `procedurelog.ProvNum` and `paysplit.ProvNum` carry the provider. | Rendering provider on transactions. | — | **Dentrix:** allocate payments to "the providers performing the treatment" (split by provider) vs the patient's primary provider; production is posted to the specific provider of the procedure. | **The procedure's treating doctor is the attribution unit.** Default it from the visit doctor at sign and freeze it. Allow a per-line change. Installment invoices are attributed to plan-item doctors by value, falling back to the primary doctor (owner D1). The primary doctor never absorbs other doctors' work. This is **DOCATTR-1**. |
| 13 | **Provider production / collection / commission** | **E (engine) / N (detail)**. One event-time, per-currency commission engine on collections (FIFO) with lab deduction. Output is one row per doctor × currency. | Provider Payroll report: production from procedures set complete in range; income allocated vs unallocated; summary and **per-patient detail**. | Collections by provider/code, production analysis. | — | Dentrix: Provider A/R totals with adjustments. | **Reuse the engine.** Add a detail sink (patient, work, invoice, collection, rate and its source) and a printable statement. No second engine. This is **COMM-DETAIL-1**. |
| 14 | **Next appointment** | **P**. `closePlannedVisitAndSuggestNext` creates the next planned visit; reception books it elsewhere. | **Planned Appointment** created in the chart, with a Planned Appointment Tracker for unscheduled ones; scheduling copies it to the pinboard. | The walkout prints the next appointment. | — | Curve: recall automation. | **Already our model** (planned visits plus the "unscheduled treatment" report). Add booking inline at checkout by reusing the existing booking API. |
| 15 | **Audit trail and corrections** | **E**. `audit_log` with sensitive actions; visit actor audit; payments append-only (0005); invoice correction (FIN-2); receipt correction (RC-1/2); addendum after sign. | Audit trail per permission; lock dates; **locked procedures: append or invalidate, never edit**. | Security groups. | — | — | **Keep.** A treating-doctor change after sign = admin correction with reason and audit (append), not a silent edit. A global lock date is a possible future item (not needed now). |

---

## Business rules extracted (applied only where they fit our architecture)

- **BR-1 — Prepayment is not revenue until the service is done.**
  - Open Dental: unearned income becomes income at procedure completion.
  - We already comply: payment without an invoice → AR credit; revenue at invoice; commission only on invoice coverage.
  - **No change.**
- **BR-2 — One revenue source per agreement.**
  - Denticon's orthodontic contract; Open Dental keeps PayPlan charges and production distinct.
  - An installment-funded plan must not also bill its sessions.
  - **BILL-1** (P0 fix).
- **BR-3 — The treating provider is on the procedure.**
  - Open Dental and Dentrix: production and collections follow the provider who performed the work, not the patient's primary provider.
  - **DOCATTR-1.**
- **BR-4 — Readiness is visible to the clinical side before seating.** Curve (vendor claim) and Denticon's "available".
  - We implement it as a derived checklist plus an acknowledgement.
  - It **never becomes a hard financial block** without an owner Setting.
- **BR-5 — Completed clinical work is corrected by append/invalidate, not edit.**
  - Open Dental's procedure lock.
  - We already comply (addendum, invoice correction, receipt correction).
- **BR-6 — Transfer (legacy) orthodontic cases start from a snapshot.**
  - Open Dental's "Is Transfer" with a transfer date instead of a banding date.
  - Supports our **legacy orthodontic baseline** with no fake history (CASE-1).
- **BR-7 — Walkout recap.** Open Dental and Denticon print today's procedures, payments and next appointment. We can print it from existing data (CHECKOUT slice).

## Rejected or deferred (with reason)

| Mechanism | Decision | Reason |
|---|---|---|
| Per-procedure hidden prepayment splits (Open Dental) | **Deferred — `REQUIRES_ARCHITECTURAL_CHANGE=YES`** | It would add a second allocation model next to our FIFO rule, which is shared by the ledger, reports and commission. Our FIFO plus on-account/plan payments already give the same accounting outcome (BR-1). |
| New visit status "ready" / "available" | **Rejected** | It would change the meaning of `visits.status`, which the TV display, board, reports and tests read. A derived readiness plus an additive timestamp gives the same signal. |
| Hard block of treatment on a previous balance | **Rejected as a default** | Forbidden by the owner's rules. An optional warning in Settings only. |
| Auto-posting of contract charges nightly (Denticon) | **Not now** | Our installments are recorded when collected (`recordPlanInstallment`); a nightly job is a separate design topic. |
| Insurance/claims (all vendors) | **Out of scope** | Not the clinic's model. |
| Global lock date (Open Dental) | **Possible later** | No incident requires it; the append-only model already protects money. |

## Sources

- Open Dental:
  - [Waiting Room](https://www.opendental.com/manual/waitingroom.html)
  - [Edit Appointment](https://opendental.com/manual/aptedit.html)
  - [Confirmation Status](https://www.opendental.com/manual/confirmationstatus.html)
  - [Unearned / Prepayment](https://www.opendental.com/manual/unearnedprepayment.html)
  - [Allocate Unearned](https://www.opendental.com/manual/unearnedallocate.html)
  - [Payment Plan](https://www.opendental.com/manual/paymentplandynamic.html)
  - [Ortho Case](https://www.opendental.com/manual/orthocase.html)
  - [Provider Payroll report](https://opendental.com/manual/reportprovpayroll.html)
  - [Select Procedure](https://www.opendental.com/manual/selectprocedure.html)
  - [Set Appointment Complete](https://www.opendental.com/manual/apptcomplete.html)
  - [Planned Appointments](https://opendental.com/manual/apptplanned.html)
  - [Procedure Lock](https://www.opendental.com/manual/procedurelocking.html)
  - [Audit Trail](https://www.opendental.com/manual/audittrail.html)
  - [API ProcedureLogs](https://www.opendental.com/site/apiprocedurelogs.html)
  - [API Appointments](https://www.opendental.com/site/apiappointments.html)
- Denticon (Planet DDS):
  - [Reception → operatory time stamps](https://support.planetdds.com/hc/en-us/articles/36804736309787)
  - [Walkout receipt](https://support.planetdds.com/hc/en-us/articles/115002089592)
  - [Why use the Ortho Payment Plan Agreement](https://support.planetdds.com/hc/en-us/articles/115002082852)
  - [Collections analysis](https://support.planetdds.com/hc/en-us/articles/23679864262299)
- CareStack:
  - [Unapplied credits](https://carestack.zendesk.com/hc/en-us/articles/46410377496852-Overview-of-Unapplied-Credit-Management)
  - [Treatment plans](https://carestack.zendesk.com/hc/en-us/articles/25880123845780-Create-a-Treatment-Plan-Add-Treatments)
  - [Patient kiosk](https://carestack.com/en-GB/dental-software/features/patient-kiosk)
  - [Payment plans](https://carestack.com/dental-software/features/payment-plans)
- Curve Dental: [Check-in process](https://www.curvedental.com/dental-blog/peed-up-the-dental-office-check-in-process) (vendor blog).
- Dentrix:
  - [Allocating patient and provider balances](https://magazine.dentrix.com/3-reasons-allocating-patient-and-provider-balances-is-so-important/)
  - [Payment allocation defaults](https://www.novonee.com/blog/DentrixPayment&AdjustmentAllocationsdefaultsformoreaccuratepatientledgers)
  - [Future Due Payment Plans (Ascend)](https://learn.dentrixascend.com/future-due-payment-plans/)
- Open source:
  - [LibreDental](https://github.com/Cojekt/LibreDental)
  - [ODental (Open Dental fork)](https://github.com/nampn/ODental)
  - [OpenDentist](https://github.com/clawnify/OpenDentist)
  - [DentalPin](https://github.com/martinezsalmeron/dentalpin)
  - [OpenMolar2](https://github.com/rowinggolfer/openmolar2)
