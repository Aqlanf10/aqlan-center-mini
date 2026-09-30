# Internal Referral Workflow

Date: 2026-09-29.
Base: `main` @ `c586b24`.
Companions:
- `MULTISPECIALTY_PATIENT_ARCHITECTURE.md`
- `DENTAL_PMS_WORKFLOW_BENCHMARK.md` (§ Multispecialty & referrals)
- `RECEPTION_TO_CHECKOUT_CHANGE_IMPACT.md`

This is a design document. Nothing marked *target* exists until slice REF-1 or REF-2 is merged.

A referral inside the center is **not a note**. It is a clinical handoff that is:
- tracked;
- scheduled;
- performed;
- closed back to the doctor who asked for it.

---

## 1. Current state (verified on `main`) — classification: **CAN_BE_EXTENDED**

| Item | Exists | Where |
|---|---|---|
| Referral record | YES, **outbound/external only** | `patient_referrals` (migration `0021`, body mirrored in `lib/referrals-schema.ts`) |
| Fields | `to_name`, `to_specialty` (fixed list in `lib/referrals.ts`), `reason`, `teeth`, `urgency` (routine/soon/urgent), `status` (sent/completed/cancelled), `outcome_note`, `doctor_party_id` (referring doctor), `doctor_name` (snapshot), `created_by/at`, `closed_by/at` | |
| DB rules | `status='sent'` ⇔ `closed_at IS NULL`; a cancellation requires a written reason; `ON DELETE RESTRICT` on the patient | |
| API | `GET/POST /api/patients/[id]/referrals`; `PATCH /api/referrals/[id]` (close with an outcome, or cancel) | Reception cannot author a referral; a clinical capability and patient access are required |
| UI | `components/PatientReferrals.tsx` (section in the patient file); printed letter `app/print/referral/[id]` | |
| Internal receiving doctor | **NO** | `to_name` is free text |
| Link to appointment / visit / plan item / case | **NO** | |
| Accept / decline / in-progress / return-to-referrer | **NO** | |

**Why extend and not replace:** the table already has the right shape for:
- the clinical ownership (the referring doctor);
- a closed-with-outcome lifecycle enforced in the DB;
- a printed letter.

An internal referral is the same document with a known receiver inside the center. A second table would create two referral engines, which the "no parallel engines" rule forbids.

External referrals keep working **exactly** as today (`EXTERNAL_REFERRALS_PRESERVED`).

## 2. Benchmark (summary; sources in the benchmark doc)

- **Open Dental** attaches a referral to **procedures**, with a status (None, Declined, Scheduled, Consulted, InTreatment, Complete) and a "Referred Procedure Tracking" report for referrals not yet completed.
- **Dentrix** has referred procedures and a "Referred Out" case status, plus a "Referred to Doctor" report.
- **CareStack** has a referral hub (inbound and outbound). It automatically updates the referring provider with visit summaries, the plan and the case status.

What we adopt:
- the referral is tied to a plan item or case (MS-3);
- tracked states;
- a "not yet completed" work list;
- an automatic return to the referrer (MS-4).

What we do **not** adopt:
- an external referral portal;
- e-fax/letters to outside offices (we already have the printed letter);
- referral fees (out of scope; see §9).

## 3. Lifecycle (target)

```
REQUESTED ─► ACCEPTED ─► SCHEDULED ─► ARRIVED ─► IN_PROGRESS ─► COMPLETED ─► RETURNED_TO_REFERRER
    │            │           │
    ├─► DECLINED (reason)    └─► (rescheduled: stays SCHEDULED, new appointment link)
    └─► CANCELLED (reason) — from any state before COMPLETED
```

- **`workflow_state` (new, nullable, CHECK)** carries the detailed state for internal referrals.
- The **existing `status` column keeps its meaning**: it is not reinterpreted, and its CHECKs stay. It is derived:

| workflow_state | status (existing) | closed_at |
|---|---|---|
| requested, accepted, scheduled, arrived, in_progress | `sent` (open) | NULL |
| completed, returned_to_referrer | `completed` | set |
| declined, cancelled | `cancelled` (reason → `outcome_note`, already required by CHECK) | set |

- External referrals have `workflow_state = NULL` and behave as today.
- Transitions are validated server-side by one pure function (`nextReferralState(current, action, actor)`) with a unit table test. An illegal transition gets **409** with an Arabic `message`.

## 4. Additive schema (REF-1)

`patient_referrals` gains nullable columns:

| Column | Meaning |
|---|---|
| `kind` TEXT NOT NULL DEFAULT `'external'` CHECK (`external`, `internal`) | Existing rows become `external` (the default, no rewrite of meaning) |
| `to_party_id` → `parties(id)` | Receiving doctor (internal). CHECK: `kind='internal'` ⇒ `to_party_id IS NOT NULL` |
| `workflow_state` | §3 |
| `case_id` → `clinical_cases(id)` | Specialty case this referral opens or serves |
| `blocks_case_id` → `clinical_cases(id)` | The case waiting on this referral (e.g. orthodontics waits for endodontics) |
| `plan_item_id` → `plan_items(id)` | The referred work item (MS-3) |
| `requested_service_id` → `services(id)` | Requested procedure, if known |
| `return_to_party_id` → `parties(id)` | Defaults to the referring doctor |
| `accepted_by`, `accepted_at` | |
| `completed_by`, `completed_at`, `returned_at` | |
| `procedure_performed` TEXT, `followup_required` BOOL, `may_return` BOOL | The completion summary sent back to the referrer |

Also:
- `appointments.referral_id` → `patient_referrals(id)` (nullable), plus a partial index on open internal referrals by `to_party_id`.
- There are no drops or renames, the old CHECKs are untouched, and no historical rows are rewritten.
- The schema contract and the ownership test are updated in the same PR.

## 5. «حجز الإحالة» — referral → appointment (REF-1)

- An open internal referral shows a **«حجز الإحالة»** button in:
  - the patient file (referrals section);
  - the receiving doctor's work list;
  - the reception «إحالات بانتظار الحجز» list.
- It opens the **existing** appointment form pre-filled with:
  - the patient;
  - the receiving doctor;
  - the requested service → duration;
  - urgency → the earliest suggested slot;
  - `referral_id`.
- The existing conflict detection, working hours and chair rules apply unchanged.
- Saving sets `workflow_state='scheduled'` in the **same transaction** as the appointment insert (audit `referral.schedule`).
- Cancelling or rescheduling the appointment keeps the referral open. A cancel returns it to `accepted`; a reschedule relinks it.
- A no-show leaves the referral in `scheduled`. It shows in the list with «لم يحضر», and reception rebooks.

## 6. Arrival → specialty context (REF-2)

- When the linked appointment is marked **arrived** (existing arrival flow; no new check-in path), the referral becomes `arrived`.
- The visit it opens carries `visits.case_id = referral.case_id`.
- The receiving doctor opening the patient lands on «زيارة اليوم» with the specialty context preselected (`?tab=today&case=<id>`).
- A banner shows:
  - «محال من د. … — السبب: … — الأسنان: …»;
  - the blocking note, e.g. «التقويم متوقف على هذا».
- Nothing is hidden. It is the same patient file and the same tabs (`MULTISPECIALTY_PATIENT_ARCHITECTURE.md` §3.7).

## 7. Progress, completion and return (REF-2)

- **Sign-off progress:** signing a visit that performs a procedure on the referral's `plan_item_id` or `case_id` moves the referral to `in_progress`.
  - This runs in the same sign transaction and is idempotent with the sign.
- **Complete:** the receiving doctor presses «إنهاء الإحالة» and fills in:
  - `procedure_performed` (pre-filled from signed procedures);
  - a free outcome note;
  - `followup_required`;
  - `may_return`.
  - Result: `completed` → `status='completed'`, `closed_at` set.
- **Return to referrer:** on completion the referral appears in the **referring doctor's** «عادت إليك» list (and the patient timeline), with the summary.
  - Opening it marks `returned_to_referrer` / `returned_at`.
  - This is an internal notification, not an SMS.
- **Blockers:**
  - When `blocks_case_id` is set, the blocked case shows «بانتظار: علاج جذور ٢١ (إحالة #…)» until the referral is completed.
  - This is warn-only (same policy as plan dependencies); an override is audited.
- **Next-step suggestion:** after completion, the summary's "What does this patient need next?" re-evaluates:
  - open plan items whose dependencies are now satisfied (e.g. «التركيبات: جاهزة للبدء»);
  - the blocked case resuming.

## 8. "My clinical work" view (REF-2)

One list per doctor (a filter on existing data, not a new module):
- referrals **to me**: requested, accepted, or awaiting scheduling;
- **my patients today** with a referral context;
- referrals **I sent** that are still open, with age and state (the "Referred Procedure Tracking" equivalent);
- **returned to me** and not yet opened.

## 9. Permissions and audit

| Action | Who |
|---|---|
| Create an internal referral (reason, teeth, plan item, blocking case) | Clinical capability (doctor / admin) with patient access (existing rule) |
| Accept / decline | The receiving doctor (`to_party_id` = the actor's party) or an admin |
| «حجز الإحالة» (schedule) | Reception, the receiving doctor, admin. **Reception cannot edit the clinical reason, teeth or outcome.** |
| Arrival | Existing arrival permissions |
| Complete / write the outcome | The receiving doctor or an admin |
| Cancel | The referring doctor or an admin (reason required, already a DB CHECK) |
| Read | Anyone with patient access (existing `canAccessPatient`) |

Audit actions:
- `referral.create`
- `referral.accept`
- `referral.decline`
- `referral.schedule`
- `referral.arrive`
- `referral.progress`
- `referral.complete`
- `referral.return`
- `referral.cancel`
- `plan.dependency_override`

Each is written in the same transaction as its change. All 4xx/5xx carry an Arabic `message`, with no exception detail.

## 10. Financial and commission implications

- A referral **creates no invoice and no payment**. It is clinical.
- Money comes only from the procedures the receiving doctor signs:
  - `visit_procedures.doctor_id` = the receiving doctor;
  - → `invoice_items.doctor_id`;
  - → the single commission engine.
- The referring doctor earns **nothing by role** (no referral fee; any fee would require an explicit owner decision and a rule inside the same engine).
- One patient ledger. The referral's work appears on the same account and in the same checkout.
- Installment-funded master plans: BILL-1 (sessions included) + DOCATTR-1/D1 (installment revenue attributed to plan-item doctors by value). The endodontist earns on the endodontic item, and the orthodontist on the orthodontic items.

## 11. Acceptance journey (PostgreSQL 18 + HTTP test, in REF-2)

«محمد أحمد»:
1. Under an orthodontic case (Dr Aqlan), tooth 21 needs endodontics.
2. Dr Aqlan creates an internal referral to the endodontist (Dr Mohammed) with `blocks_case_id` = the orthodontic case.
3. Reception presses «حجز الإحالة» → an appointment with `referral_id`.
4. Arrival → the visit opens in the endodontic context.
5. Dr Mohammed signs the root canal → the referral is `in_progress`.
6. Dr Mohammed completes it with an outcome → `completed`.
7. Dr Aqlan sees «عادت إليك» → `returned_to_referrer`.
8. The orthodontic case is unblocked, and the summary suggests the next open item (prosthodontics).

Assertions:
- one patient, one ledger;
- commission for Dr Mohammed = the endodontic lines only;
- zero commission to Dr Aqlan from the referral;
- every transition audited;
- illegal transitions → 409 Arabic;
- external referrals are unchanged (an existing test suite stays green).

## 12. Status

Implemented by REF-1 (migration `0033`) and REF-2 (no migration):
- REF-2 hooks: arrival (`arriveAppointment`, and `transitionAppointment` → arrived) moves `scheduled → arrived` and sets `visits.case_id`; a cancelled / no-show / deleted appointment moves `scheduled → accepted` (or `requested` if it was booked before acceptance) — audited `referral.unschedule`, the list shows «لم يحضر»/«أُلغي الموعد». **Deviation from §5:** a no-show does not stay `scheduled`; it returns to waiting-for-booking so reception sees it in the rebook list (owner/coordinator decision).
- Sign-off progress inside `signClinicalVisit` (plan item match, or visit case + receiving doctor) → `in_progress`, audited `referral.progress`, no billing change.
- Blockers: `patientWorkflow` alert `referral_blocker` and `SpecialtyCase.waitingOn`.
- Timeline kind `referral` (from the audit rows of each step); «عملي السريري» page `/my-work` (`GET /api/referrals/mine` + today's own appointments).
- REF-3 (no migration): the visit screen shows the arrival banner «📨 محال من د. … — السبب: … — الأسنان: …» with the
  referral's case and the case waiting on it (`ClinicalVisit.referral`, from the appointment's referral or an open referral
  in the visit's case); «مرضاك اليوم» opens an arrived patient on «زيارة اليوم» (the visit already carries the case, so the
  specialty context needs no extra query parameter). Next step after completion (§7): the summary shows
  `referral_returned` «اكتملت الإحالة #… : يمكن استئناف حالة «…»» until the referrer acknowledges it (and only while no
  other referral still blocks that case), and `plan_ready` «جاهز للبدء: «…» — اكتمل ما يتطلبه.» for a planned item whose
  requirements are now all met. Read-only alerts — no state or money changes.

Status after REF-1 + REF-2 + REF-3:

```
INTERNAL_REFERRALS_SUPPORTED=YES
EXTERNAL_REFERRALS_PRESERVED=YES (existing table, API, letter unchanged; new columns nullable/defaulted)
REFERRAL_TO_APPOINTMENT_LINK=YES (appointments.referral_id + «حجز الإحالة»; fallen appointment returns it to booking)
REFERRAL_OPENS_SPECIALTY_CONTEXT=YES (arrival → visits.case_id; banner in the visit screen)
RETURN_TO_REFERRER_SUPPORTED=YES («عادت إليك», acknowledge → returned_to_referrer; next-step alerts)
REQUIRES_ARCHITECTURAL_CHANGE=NO (additive extension of patient_referrals)
```
