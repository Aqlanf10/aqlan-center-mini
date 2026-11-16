# Shared prosthetic work: allocating the lab cost between doctors (proposed migration 0134)

Status: **contract only — no code, no migration yet.** Branch `feat/claude-shared-lab-cost-allocation-20261116`, based on the staging candidate `4e88b6a7`. It is not part of that candidate.

## 1. Owner decision (#483 6902952517 and 6904933217)

> «اذا طبيبين اشتركا بعمل التركيبه من التحضير الى التركيب اكيد يتشاركا حسب انجاز كل طبيب للاعمال المشتركه او الادارة كخيار اخر تقوم بفصل الموضوع هذا»
>
> «البرنامج يوزعها حسب نسب العمل والادراه ايضا يمكنها ذلك بحيث يمكنني تفعيل الاثنيتن ومراجعه وتعديل او تفعيل اي واحده منها من الاعدادات لا تعلق اي شي بالسؤال الثالث»

Read as:

1. The program allocates the lab cost by the doctors' work shares.
2. Administration can also set the allocation itself.
3. The owner can enable either or both from the settings, and review and change that later.
4. Nothing is held because no participation decision exists yet.
5. No invented percentages; immutable history; approved payroll is never rewritten silently.

## 2. What exists today (verified on `4e88b6a7`)

| Behaviour | Evidence |
|---|---|
| An approved participation decision (0126) splits a case's invoice lines by `shareBp`; the lab cost is split by the same shares; each doctor's own lab-deduction policy then applies | `lab-commission-acceptance` "shared crown": 60/40 → cost 120/80, accruals 144 and 128, one payable |
| The decision is administrative, append-only, attributed (who, when, source, reason) and audited; a later decision supersedes; an approved payroll run is not rewritten | `commission-case-participation-db` |
| With no decision, the whole line and its lab cost stay on the invoice-line doctor; nothing is held | same suites |
| An explicit `pending` decision holds the case's commission until it is approved or voided | `commission-case-participation-db` |

Point 4 is met when no decision exists. It is **not** met for an explicit `pending` decision, which holds the case's commission today. The owner clarified (#483 6905003552) that an explicit pending decision must not hold either; section 4.6 designs that change.

## 3. What is missing

- Administration cannot give the lab cost an allocation different from the work shares.
- There is no setting to enable or disable either basis.
- The commission report does not say which basis a line's lab cost used.

## 4. Proposed contract

### 4.1 Settings (finance; changed by the protected owner only, with a written reason, audited)

| Key | Default | Meaning |
|---|---|---|
| `commission.shared_lab_cost.by_work_shares` | `on` | A shared case's lab cost follows the approved work shares. This is today's behaviour. |
| `commission.shared_lab_cost.admin_allocation` | `off` | A participation decision may carry an explicit lab-cost allocation, and it is used when present. |

Resolution for a line of a shared case, in order:

1. `admin_allocation` is on **and** the decision in force carries a lab-cost allocation → that allocation. Basis `admin_allocation`.
2. `by_work_shares` is on → the work shares. Basis `work_shares`.
3. Otherwise → the whole cost stays on the invoice-line doctor. Basis `line_doctor`. **This third step is a proposal, not an owner decision** (6905003552); it is implemented only once the owner confirms it.

A case with no approved decision is never shared: basis `line_doctor`, as today.

A setting change is not retroactive for payroll: it changes what later reports and later runs compute; an approved run keeps its figures and the next run absorbs the difference, exactly as a new participation decision does today.

### 4.2 Storage (migration 0134, additive)

- Each participant object of `commission_case_participations.participants` may carry an optional integer `labCostBp` (0–10000).
- Either no participant carries it, or all do and they sum to 10000. Enforced by the database check, not only by the service.
- Rows written before 0134 have no `labCostBp` and keep meaning "by work shares".
- The table stays append-only. Changing an allocation is a new superseding decision with its own reason and audit row.
- No backfill, no change to existing rows, no change to 0126's file.

### 4.3 Writer

`decideCaseParticipation` accepts `labCostBp` per participant only when `admin_allocation` is on; otherwise it refuses with an Arabic message and writes nothing. The existing head check, lock order and audit stay as they are; the audit row records the lab-cost allocation.

### 4.4 Readers

- The commission engine allocates `labCostMinor` by the resolved basis (largest-remainder rounding as today, so the parts always add up to the cost).
- Each commission line reports its basis (`work_shares`, `admin_allocation`, `line_doctor`) so the screen and the statement can state it. No percentage is shown that was not recorded.
- The lab payable is untouched: one row, the lab's price, whatever the allocation.

### 4.5 Screen

The participation decision form gains an optional "توزيع تكلفة المعمل" row per participant, shown only when the setting is on. The commission detail shows the basis next to the lab cost.

### 4.6 An explicit pending decision no longer holds the commission (owner clarification 6905003552)

Today a `pending` head removes the case's lines from every doctor until it is approved or voided. Proposed behaviour:

- `pending` becomes a visible review marker only. While the head is pending, the case's lines and lab cost are computed exactly as if no decision existed (basis `line_doctor`), and each line is flagged "قرار المشاركة قيد المراجعة" in the commission detail and statement.
- Payroll calculates and may be approved with a pending head. Approval is never blocked by it.
- When the decision is later approved, the split applies to later reports and runs. An approved run is not rewritten: the next run pays the participant who gains and carries the other, by the mechanism that already handles a decision made after an approved run.
- The record stays append-only and audited; no new storage is needed for this part, so it does not depend on the migration.
- Existing tests that assert the hold ("a pending case holds its commission") change deliberately, citing this decision; they are not deleted.

Risk to state plainly: commission can be paid to the invoice-line doctor during the review and partly reversed against that doctor's later commission after approval. That is the consequence of not holding, and it uses the existing carry-forward (never taken from base salary).

## 5. Tests to write first (red before code; synthetic data)

1. Defaults: 60/40 work shares → cost 120/80 (regression of today's figures).
2. `admin_allocation` on, decision with cost 100/0 on a 60/40 work split → A carries 200, B carries 0; accruals follow; one payable.
3. `admin_allocation` on but the decision has no cost allocation → falls back to work shares (or to the line doctor when `by_work_shares` is off).
4. Both off → whole cost on the invoice-line doctor.
5. Writer refusals: allocation sent while the setting is off; partial allocation; sum ≠ 10000; unknown doctor. Nothing written, Arabic message.
6. Database check refuses a malformed allocation inserted directly; update and delete still refused.
6a. Pending: a pending head changes no figure; payroll calculates and approves; the lines carry the review flag; approving afterwards moves the split to the next run and leaves the approved run untouched.
7. Supersede: a new decision changes the allocation; an earlier report period keeps the earlier one; an approved payroll run is not rewritten and the next run absorbs the difference.
8. Concurrency: two decisions on the same head, one wins (existing lock-then-admit pattern).
9. Settings: only the protected owner changes either key; the legacy route refuses; audited; a change affects later computation only.
10. Upgrade: a database at 0133 with existing decisions applies 0134 and keeps every figure.

## 6. Migration impact

- One additive migration, proposed number **0134** (0130 and 0131 are assigned to deferred work). Not yet confirmed.
- Replaces one SQL function (`aqlan_commission_participants_total_bp`) with a version that also accepts the optional key, and adds one check. No table rewrite, no data change.
- Rollback before use: restore the pre-upgrade backup, as for the candidate.

## 7. Open points before implementation

- **Migration number.** 0134 is a proposal only. The coordinator is checking availability independently (6905003552); nothing is allocated until that is agreed.
- **Both settings off.** "Whole cost on the invoice-line doctor, disclosed as such" is my proposal, not an owner decision.
- **Decided:** an explicit pending decision does not hold the commission (6905003552); see 4.6.
