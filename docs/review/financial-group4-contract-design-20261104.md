# Group 4 — the financial contract, design before code (2026-11-04)

Group 3 (clinical) ends with slice 87. Group 4 moves the money routes to the canonical runtime.

This note does three things:
- inventories every remaining financial route and its rule from the approved map (names approved by the owner, Dot 6484846432);
- classifies what each read shows under the owner's money rule;
- isolates the questions only the owner can answer.

Nothing here changes behaviour until the slices land.

## 1. Rules in force

- **Money rule (6615124926).** Prices and financial information only for actors explicitly granted the matching type — in the server, the API, direct access, search, export and print. View and edit are separate. No automatic grants.
- **Owner decisions 6629149113.**
  - The visit's amounts need `finance.invoices.view` explicitly.
  - `finance.patient-ledger.view` is a separate grant; neither grants the other.
  - A clinical-financial decision belongs to whom the owner names. A finance grant is never a substitute.
- **Never wider than legacy.** A role label's reach may narrow to an explicit grant, never widen.
- **Unchanged business rules**, carried as they are:
  - an open cashier shift for collection, payment correction, debt collection and treasury expenses;
  - the treasury's no-negative rule (`finance.prevent_negative_treasury_balance`, via `TreasuryResolutionService` semantics);
  - the discount ceiling `billing.max_discount_percent`;
  - commissions on both paths (accrued and earned);
  - `finance.locked_before`.
- **Pattern for every slice:**
  - one admitted transaction per write, with the legacy writer extracted (`…On`) and its lock order kept;
  - audit in the same transaction;
  - request keys where a retry could duplicate money;
  - reads on one owning snapshot, through an allowlist projection;
  - tests for permit / refuse / revoke / direct access / no leak in replies.

## 2. Inventory (from the approved map)

| Area | Routes | Canonical rule (map) | Money projection |
|---|---|---|---|
| **Patient account** | `GET ledger`, `statement`, `treatment-financial-context`, `debt-repayments`, `legacy-balance-arrangement`; `GET /api/finance/debts` | `finance.patient-ledger.view` inside the patient scope | the whole response is financial |
| **Responsibility** | `GET/PATCH responsibility` | `finance.patient-ledger.manage` | — |
| **Visit money** | `GET billing-preview`, `financial-context`, `walkout` | `finance.invoices.view` | amounts, dues, invoice references; payments only with `finance.payments.view` (decision G4-4) |
| **Collection** | `POST /api/payments`, `payments/attempts/retire`, `debt-repayments` (create, collect), visit `defer` | `finance.payments.collect` + an open shift | — |
| **Payment correction** | `POST payments/[id]/correct` | `finance.payments.void` (+ `finance.payments.collect` for "correct") + an open shift | — |
| **Payment reads** | `GET /api/payments` | `finance.payments.view` | — |
| **Invoices (read)** | `GET invoices`, `[id]`, `archive` | `finance.invoices.view` | — |
| **Invoices (write)** | `POST/PATCH invoices`, `add-service`, `clinical-preview` | `finance.invoices.create`; discounts within the ceiling `finance.discounts.apply`, beyond `finance.discounts.override`; increases `finance.price-increases.apply` | — |
| **Invoice cancel / correct** | archive POST; correct | `finance.invoices.cancel`; `finance.invoices.correct` | — |
| **Plans (money)** | plan totals and prices, `financial-approval`, `agreement-amendment`, `reconcile` | `finance.invoices.create` (approval); `finance.agreements.manage` (amendment, reconcile) | the canonical plan reads carry **no money at all** today (decision G4-1) |
| **Plans (clinical writes with prices)** | `POST/PATCH plans`, `items`, `consent` | `clinical.plans.edit` | a price on an item is a money write (decision G4-1) |
| **Historical onboarding** | `legacy-treatments` (record, void, preview), `legacy-balance-arrangement` writes, `historical-documents` | `finance.legacy.record` / `finance.legacy.void`; `patients.history.record` / `.correct` | the GET routes have **no grant in the map** (decision G4-2) |
| **Expenses** | `expenses`, `attachments`, `quote`, categories | `finance.expenses.view` / `.create` / `.void`; categories `settings.finance.edit` | treasury payment: open shift |
| **Payables / parties / openings** | `payables`, `parties`, `opening-balances`, `party-openings` | `finance.suppliers.view`, `finance.payables.record`, `finance.parties.manage`, `finance.opening-balances.manage`, `finance.reconciliation.view` | — |
| **Reconciliation / FX / lab accounting** | `finance/fx`, `reconciliation`, `lab-reconciliation`, `lab-accounting` | `finance.reconciliation.view` / `.manage`, `finance.fx.manage` | — |
| **Prices and costs** | `services` (+ `prices`, `provisional`), `service-materials` | `finance.service-prices.view` / `.edit`; materials read `finance.cost-prices.view` | the catalogue without prices is not served today (decision G4-3) |
| **Accounting and reports** | `accounting`, `finance/report`, `reports`, `report`, `reports/daily-clinic`, `reports/saved`, `executive*`, `finance/commissions*` | `finance.journal.post`, `reports.financial.view`, `reports.operational.view`, `finance.profits.view`, `finance.commissions.view-all` / `view-own` / `manage-rates` | per report; operational reports carry no money (decision G4-5) |

## 3. Decisions for the owner — all eight decided (6648682456, 2026-11-05; see section 5)

**G4-1 — Plan amounts.**
- *Already in force:* the canonical patient workflow summary (M2 slice 6) shows each active plan's account figures (total, done, remaining, overdue, next due date, currency) with `finance.patient-ledger.view`. The canonical plan reads carry no money at all.
- *Proposal, consistent with that precedent:*
  - account-level plan figures — total, paid, remaining, instalments, agreement funding — with `finance.patient-ledger.view`, as in force;
  - item-level prices — what becomes an invoice line — with `finance.invoices.view`, as the visit's amounts (decision 6629149113);
  - writing a price on a plan item with `finance.invoices.create`, besides `clinical.plans.edit`.
- *Alternative:* one grant for all plan money.

**G4-2 — Historical documents and onboarding reads** (`GET legacy`, `legacy-onboarding`, `legacy-treatments`, `historical-documents`). The map gives them no grant.
- *Proposal:*
  - existence and clinical description with the patient record read (inside the scope);
  - every amount, balance and agreement term with `finance.patient-ledger.view`.

**G4-3 — A service catalogue without prices** for the visit screen's free procedure picker (`GET /api/services` is priced today).
- *Proposal:* a price-free catalogue read for `clinical.visits.document`; prices stay with `finance.service-prices.view`.

**G4-4 — The visit walkout and checkout** (`walkout`, `financial-context`).
- *Proposal:*
  - dues and invoice references with `finance.invoices.view`;
  - payments already received with `finance.payments.view`;
  - the "collect" action offered only with `finance.payments.collect`.
- Reception accounts receive these grants only by the owner's explicit choice. Today the reception label sees dues implicitly; nothing is granted automatically.

**G4-5 — Operational reports** (`reports/daily-clinic`, `report`).
- *Proposal:* counts and clinical activity with `reports.operational.view`; any amount inside them with `reports.financial.view`.

**G4-6 — The legacy setting `workflow.doctor_financial_view`** (a role-label toggle).
- *Proposal:* it has no effect on canonical sessions, where a doctor sees money only through explicit grants. Its help text says so. It is not migrated into an automatic grant.

**G4-7 — The case's responsible doctor** (`GET/PATCH /api/patients/[id]/responsibility`).
- *What the route does:* it reads and changes the responsible doctor of a clinical or orthodontic case (legacy: admin label only, a written reason, audited).
- *Why it is a question:* the map gives it `finance.patient-ledger.manage`, whose label is "payment responsibility and patient account". The route sets the case-doctor link instead — the link that decision 6629149113 uses for the "no charge" authority, and that the clinician's own patient scope follows. A finance grant would then decide a clinical-financial authority, which that decision rules out.
- *Proposal:*
  - the protected owner only, as the legacy admin-only rule, until the owner names a grant;
  - or a clinical grant the owner names (for example `clinical.plans.edit`); never a finance grant alone.
- *Until decided:* canonical sessions are refused on this route (slice 88 leaves it on legacy).

**G4-8 — Invoice reads and the patient scope.**
- *The map:* lists the invoice reads (`GET invoices`, `[id]`, `archive`) with no record scope.
- *In force since slice 92:* the canonical reads keep them inside the actor's patient scope, the same as the patient account. An `own`-scoped actor granted `finance.invoices.view` reads only its patients' invoices.
- *Why:* a scope-free invoice read would let an invoice grant bypass the case-doctor patient scope (decision 6629149113, point 3).
- *Question:* should finance-only roles read invoices without a patient scope, or is patient scope `all` the explicit way to grant it, as in force?

## 4. Slices (each after its decision where one is listed)

| Slice | Content | Waits on |
|---|---|---|
| 88 | Patient account reads (ledger, statement, treatment-financial-context, debts list, legacy balance arrangement read, debt-repayment workspace) — **done** | — |
| 88b | Responsibility (the case's responsible doctor) | decided (G4-7) |
| 89 | Visit money reads (billing preview, financial context, walkout) | decided (G4-4) |
| 90 | Payment reads and collection (payments, attempts retire, defer) with the shift rule and request keys | decided (G4-4) |
| 91 | Payment correction/void; debt repayment arrangements and collection — **done** | — |
| 92 | Invoice reads and archive reads — **done** (patient-scoped; G4-8) | — |
| 93 | Invoice writes: status (93a **done**), create and add-service and clinical preview (93b, G4-1 price controls), archive cancel and correct (93c) | decided (G4-1) |
| 94 | Plan money reads and writes, financial approval, amendment, reconcile | decided (G4-1) |
| 95 | Historical onboarding and documents | decided (G4-2) |
| 96 | Price-free service catalogue; services and prices; service materials | decided (G4-3) |
| 97 | Expenses, payables, parties, openings, FX, reconciliation, lab accounting | — |
| 98 | Accounting, financial and operational reports, executive, commissions | decided (G4-5) |

## 5. Owner decisions 6648682456 (2026-11-05), binding

The owner approved the eight recommendations, under least privilege and with read, write and scope kept separate. Each decision lands in the slice shown.

| # | Decision | Lands in |
|---|---|---|
| G4-1 | Account totals, balance and debt need `finance.patient-ledger.view`. Item prices and the invoice's financial details need `finance.invoices.view`. Neither grants the other. Writing a price needs the write grant matching the act: `finance.invoices.create` when invoicing, with the settled price controls — `finance.discounts.apply` with a reason inside `billing.max_discount_percent`, `finance.discounts.override` beyond it, `finance.price-increases.apply` above the catalogue. A read grant never allows a write. | 93b (invoice create and add-service), 94 (plan money) |
| G4-2 | The historical record and its clinical description appear with the patient-file read, inside the scope. Amounts, financial terms and instalments need `finance.patient-ledger.view` inside the scope. **The original mixed attachment** is protected too: if it carries money, hiding fields in JSON or the screen is not enough. Its download, preview, print and export sit behind the financial guard. A clinical reader who needs a copy gets a redacted rendering that shows no money; the original is never changed. | 95 |
| G4-3 | A price-free clinical catalogue view for `clinical.visits.document`. It returns no price, cost or hidden financial field, and grants no financial or price-editing authority. | 96 |
| G4-4 | Dues need `finance.invoices.view`; payments need `finance.payments.view`; the collect action needs `finance.payments.collect`. Each is bound to the patient scope and the existing writer controls. An action grant never implies its read, and an action's response reveals no unauthorised financial data. No grant is given automatically to reception or any account. | 89, 90 |
| G4-5 | Operational counts need `reports.operational.view`; money fields need `reports.financial.view`. The patient or clinical scope holds for patient-linked information, aggregates included. Profit and purchase cost are never revealed implicitly; their own controls and grants stay. | 98 |
| G4-6 | `workflow.doctor_financial_view` is not a grant for canonical sessions, nor a source for migration or automatic grants. Only explicit canonical grants count. The legacy route behaviour stays as it is; the setting is not removed. | 89 (help text and tests) |
| G4-7 | Changing a case's responsible doctor is for **the protected owner only**, for now. A finance grant or a general administrative label never does it. A written reason is required, and the audit records the actor and the previous and new doctor inside the transaction. Any later delegation needs an explicit decision and a narrow, independent clinical grant; no general delegation is created now. The change is never a hidden way to widen scope or bypass the "no charge" controls. | 88b (now) |
| G4-8 | Invoice reads stay bound to the patient scope, with no automatic bypass for financial roles. Patient scope `all` may become an explicit financial grant only once it is proved not to widen clinical access. Where the shared scope `all` would widen clinical exposure, the current refusal stays, and a design separating the financial scope from the clinical one comes first. No `all` and no grant is given to real accounts in this work. | in force since 92 and 93a; the financial/clinical scope separation design comes before any financial use of `all` |

**Bounds of the approval:** design, implementation and tests on the WORK branch only. No change to real patients, doctors or accounts. WORK stays Draft, with no merge to main or REVIEW and no deploy or activation. Before Production: Staging first, then the owner's explicit personal approval.

## 6. Slice 89 — the visit's money reads, field by field (G4-1, G4-4, G4-6)

**Rule for derived fields:** a value computed from inputs under different grants is shown only to an actor holding **every** one of those grants. For example, today's remainder is the invoice net minus what was paid, so next to the net it reveals the payments. A hidden group is **omitted**, never replaced by zero: a zero would read as "nothing due" or "nothing paid".

**Owner:** the protected owner holds every group.

**`workflow.doctor_financial_view` (G4-6):** has no effect on canonical sessions. The legacy route keeps its behaviour, and the setting stays.

### `GET /api/visits/[id]/billing-preview`

- **Admission:** `finance.invoices.view`, inside the patient scope; outside reads like missing.
- **Body:** the whole response is dues (per-line amounts and dues per currency), so it is the legacy body as is.

### `GET /api/visits/[id]/financial-context`

- **Admission:** `clinical.visits.document` **or** `finance.invoices.view`, inside the patient scope. Legacy served clinical roles a redacted body and money roles the full one.
- **Source references** (`directReference`, `references`: invoice and agreement identifiers and their links) are shown with `finance.invoices.view` only.
- **The coverage state, decisions and reasons** are clinical facts, shown to both.
- **Never wider:** the legacy redaction function (`redactVisitFinancialContext`) is reused, with the grant in place of the role label.

### `GET /api/visits/[id]/walkout`

**Admission:** `finance.invoices.view`, the map's grant, inside the patient scope. The groups:

| Group | Fields | Grants |
|---|---|---|
| Visit | visit id, patient id, name and number, arrival and signing, doctor, treatment done and next plan, line descriptions, teeth and quantities, billing class, ortho adjustment class and decision, next appointment, `deferred`, `signedToday` | admission |
| Dues | `invoice` (id, number, net, currency); each line's `unitPriceMinor`, `currency`, `included` and `financialReviewRequired`; each summary line's `newBillableMinor` | `finance.invoices.view` |
| Payments | `payments` (the day's receipts); `checkout.paymentsToday`, `checkout.openingPaidToday`, `checkout.invoicePaidMinor`; each summary line's `paymentsTodayMinor` | + `finance.payments.view` |
| Account | `balances`; `checkout.previous`, `checkout.current`; each summary line's `previousBalanceMinor`, `currentBalanceMinor`, `legacySuggestedMinor`, `legacyRemainingMinor` | + `finance.patient-ledger.view` (G4-1: account totals and balance) |
| Derived dues | each summary line's `todayRemainingMinor` (net − paid on the invoice) | invoices **and** payments |
| Derived dues | each summary line's `dueNowMinor`; the `dueRecommendation` (sources, remaining, due now, account link) | invoices **and** payments **and** the ledger |
| Action | `dueRecommendation.collectionAction` other than `"none"` | additionally `finance.payments.collect` (G4-4: the action is offered only with its grant; an action grant never implies a read) |
| Handoff | `receptionHandoff` status | `visits.manage` (the operational queue grant; legacy admin and reception labels) |

Every response passes through an allowlist projection, never object spreading.

**Tests:** a field matrix per grant combination, with each derived field refused without any one of its inputs; revocation; outside reads like missing; and no hidden field in the serialized body.

## 7. Slice 93b — creating invoices, adding a service, the clinical preview (G4-1, G4-8)

This section is written before the code. It is the field-by-field contract for the three routes that write prices onto an invoice.

### Admission and scope

| Route | Admission (canonical) | Legacy |
|---|---|---|
| `POST /api/invoices` | `finance.invoices.create`. Lines carrying lab work also need `clinical.visits.document` (the map's field rule). Repayment terms also need `finance.payments.collect`, because they create a debt arrangement (slice 91). | Money roles; lab work for doctor or admin |
| `POST /api/invoices/clinical-preview` | The same as creation (read-only, same parser and price engine) | Money roles; lab work for doctor or admin |
| `GET`, `PUT`, `POST /api/invoices/[id]/add-service` | `finance.invoices.create` (the map's rule), plus the price controls below. The explicit grant replaces the administrator label, as in every slice; no label decides. | Administrator label only |

Scope rules (G4-8): the patient (for add-service, the invoice's patient) must be inside the actor's patient scope.
- **Writes:** scope is decided after the writer's locks, with a positive ownership witness `FOR SHARE NOWAIT` held until commit, after an early unlocked look. Outside the scope reads as missing (404).
- **Preview:** decided once on its own read.

### Price controls (G4-1): role labels replaced by grants, never wider than legacy

The price controls take the same inputs as `checkInvoiceAuthority`. Each legacy role check becomes an explicit grant:

| Price change | Canonical requirement | Legacy |
|---|---|---|
| Catalogue line priced below the catalogue, within `billing.max_discount_percent` | `finance.discounts.apply` and a written reason | Same ceiling for non-admins; admin unlimited |
| Below the catalogue, beyond the ceiling | `finance.discounts.override` and a reason | Admin only |
| Above the catalogue, or above a configured zero price | `finance.price-increases.apply` and a reason | Admin only |
| Whole-invoice discount | A reason always. Beyond the ceiling, alone or combined with line discounts: `finance.discounts.override` | Admin beyond the ceiling |
| Service not priced in this currency, written by hand | A reason (at least 3 characters), with no additional grant | The invoice rule for every money role; kept as is |
| Manual line without a service | Free (audited in `invoice.create`) | As legacy |

Every override and discount is recorded in the invoice's audit, in the same transaction, as today.

The legacy engine also re-checks the price authority inside the transaction ("صلاحية السعر" in the stale refusal). In the canonical runtime that re-check uses the same grants, read on the operation's client.

### Session-bound writers: branded actors (never from JSON)

The legacy writer revalidates a session at several points. In the canonical runtime each point receives a value minted only by the operation. Each re-proves the live operation and its grant on the same client.

| Writer | Today | Canonical |
|---|---|---|
| Invoice template or catalogue authority (`assertInvoiceTemplateSession`, replay recovery) | Session with a money role, matching username and role | Invoice actor: `finance.invoices.create` |
| Lab work lines (`materializeInvoiceLabWork…`) | Session `userId` | The lab actor of slice 87 |
| Repayment terms (`saveDebtRepaymentOn`) | Session | The debt actor of slice 91 (`finance.payments.collect`) |
| Add-service (`authorize`, request fingerprint) | Administrator session; `actor { id, username, role }` | Invoice actor. The fingerprint keeps its shape with the canonical identity, so a key never crosses actors. |

### Responses

Responses keep the legacy bodies. Creation returns the invoice, its clinical links, and lab work, the visit and repayment where requested, with `replayed`. The preview returns lines, plan choices and lab-work support. Every response is marked `no-store`.

No read grant opens any of these writes. The invoice view never offers a price change.

### Tests

The tests required before any commit:
- the grant matrix per route, including view-only, label-only and revocation cases;
- each price control: within the ceiling, beyond it, an increase, an unpriced service, and the invoice discount combined with line discounts;
- lab work lines without `clinical.visits.document`, and repayment terms without `finance.payments.collect`;
- an outside patient (404, nothing written);
- replay recovery by the same actor, with another actor refused;
- a race test shown failing first: the patient leaving the scope during the writer's wait;
- the legacy suites unchanged.

## 8. Slice 93c — archiving, restoring and correcting issued invoices (G4-8)

| Route | Admission (canonical) | Legacy |
|---|---|---|
| `POST /api/invoices/[id]/archive` (archive or restore) | `finance.invoices.cancel` | Administrator label only |
| `GET /api/invoices/[id]/correct` | The read `read:invoices.correct` (`finance.invoices.correct`) | Administrator label only |
| `POST /api/invoices/[id]/correct` | `finance.invoices.correct` | Administrator label only |

The rules:
- **Grants:** the grants are the map's rule and replace the label; neither implies the other.
- **Scope:** inside the invoice's patient scope. The writers decide it right after their patient row lock, through an ownership witness, after an early unlocked look. Outside the scope reads as missing.
- **Session revalidation points:** the slice-91 branded actor re-proves the live operation and its grant at each point where the legacy writer revalidated a session, including the correction's repayment terms through the debt writer.
- **Durable archive rejections:** these (period locked, policy decision required) still commit their evidence before the refusal.
- **Prices in a correction:** the legacy correction had no price ceiling (the administrator was unlimited). No new price policy is layered on `finance.invoices.correct` here. Whether a correction should also be bound by the discount, override and increase controls is a question for the owner.

## 9. Slice 94a — the plan list, field by field (G4-1, G4-6, G4-8)

This section is written before the code. It covers `GET /api/plans` (one patient's plans with `?patientId=`, otherwise the active plans).

### Admission

The registered read needs `clinical.plans.view`, `finance.invoices.view` or `finance.patient-ledger.view` (the map's `anyOf`, widened by the ledger read that G4-1 names for totals). The rows stay inside the patient scope:
- `own`: only the validated clinician's patients;
- `all`: every plan;
- without `?patientId=`, the list keeps only in-scope rows.

The legacy `workflow.doctor_financial_view` and the role labels decide nothing (G4-6).

### Projection

The projection is an allowlist; a hidden group is omitted, never nulled or zeroed.

| Group | Fields | Grant |
|---|---|---|
| Identity | `id`, `patientId`, `patientName`, `patientPhone`, `status`, `startDate`, `createdAt`, `baseCurrency`; the plan picker's structure as legacy gave every reader (`withoutPlanPayments`): `agreementApproved`, `hasInstallments`, and `installments` as identities only (`{ id }`) | Any admitting grant |
| Clinical | `title`, `note`; items without money (`id`, `serviceId`, `serviceName`, `category`, `toothCode`, `surfaces`, `quantity`, `status`, `visitId`, `doneAt`, `note`, `plannedVisitNumber`, `sessionCount`, `sessionsCompleted`, `doctorId`, `doctorName`, `caseId`, `caseSite`, `clinicalConsentRecorded`); `itemsProgress.count` and `.doneCount`; `consentAt`, `consentBy`, `consentNote`, `totalFromItems` | `clinical.plans.view` |
| Agreement total | `totalMinor` | `finance.invoices.view` or `finance.patient-ledger.view` |
| Prices (G4-1: item prices and invoice details) | each instalment's number, due date and amount (the schedule). On items (present only with the clinical group): `unitPriceMinor`, `totalMinor`, `billingRule`, `billingStatus`, `origin`, `originInvoiceId`, `billedInvoiceId`, `financialReviewRequired` and the legacy agreement fields; `itemsProgress.totalMinor`, `.doneMinor`, `.remainingMinor` | `finance.invoices.view` |
| Account (G4-1: totals, balance and debt) | `paidMinor`, `progress`, `invoiceFinancial`, `approvedAgreement`, `debtSource`, `lastReminderAt` and each instalment's `lastReminderAt` | `finance.patient-ledger.view` |

The agreement total is both an invoice detail and a ledger total, so either money grant shows it. The account group's `progress` (paid, remaining, overdue, next due date and amount, counts) is the same position the ledger summary of slice 88 (`planLedgerSummary`) already shows with `finance.patient-ledger.view`. This keeps one answer per grant across the two reads. The ortho package link (`OrthoPackageLink`) refuses a plan without an `installments` array, so the identities stay for every reader; a review of the screens before the commit found this. The first draft of this table put the total under prices alone. The PostgreSQL test found that `progress` repeats it, and the table was corrected to the reviewed slice 88 contract rather than hiding a field that the account read already returns.

A finance-only reader (prices or account, without `clinical.plans.view`) gets the title `خطة مالية #<id>`, as legacy finance roles did, and no clinical group.

### Tests

The tests required before any commit:
- the grant matrix with a distinct sentinel per group (each hidden group absent from the JSON);
- scope `own` versus `all`, with and without `patientId`;
- a role label without grants refused;
- G4-6: the legacy setting has no effect;
- revocation.

## 10. Slice 94b — plan status, the creation entry and the plan collection (G4-4, G4-8)

This section is written before the code.

| Route | Legacy | Canonical |
|---|---|---|
| `PATCH /api/plans/[id]` (status) | Money roles (`canHandleMoney`); `setPlanStatus` locks the plan row, requires a written reason to cancel or revive a cancelled plan, and audits in the same transaction. | `clinical.plans.edit` (the map's grant). One admitted operation on the same writer (`setPlanStatusOn`). |
| `POST /api/plans` (creation entry) | After the role and patient checks, always 409 `PLAN_CREATION_ENTRY_REQUIRED`: new treatment starts from the invoice or the pre-system agreement. | `clinical.plans.edit` inside the scope, then the same 409. Nothing is written. Outside the scope reads like a missing patient (404). |
| `POST /api/plans/[id]` (collect on a plan) | Money roles. The approved agreement's collection, else the next instalment with its invoice, under the open shift, with the idempotency key and the similar-collection review. | `finance.payments.collect` (G4-4: collection is `payments.collect`). The map entry's `clinical.plans.edit` is corrected to it: this route moves money. The same two writers as slice 90c, with the same response bodies and refusals as the legacy route. |

### Scope and locks

- **Early look:** an unlocked read of the plan's patient. A plan outside the scope gives the same message as a missing plan (`الخطة غير موجودة.`, 404).
- **Status:** the scope is decided right after the plan row lock (`FOR UPDATE`) and before the status is read or changed. An `own` actor needs a positive ownership witness `FOR SHARE NOWAIT`, held until commit; a lock conflict is 409. The witness is taken before the update, because cancelling the plan can itself end the clinician's scope (an active plan with them as primary doctor is part of the predicate).
- **Collection:** the scope is decided by each writer's `admit`, after its own locks (slice 90c).

### What decides nothing

- Role labels.
- `finance.payments.view`, `finance.invoices.view` and the ledger view.
- `clinical.plans.edit` for a collection, and `finance.payments.collect` for a status change.

### Tests required before the commit

- Status:
  - change with its audit;
  - the reason rule;
  - view grants, the collect grant and the label refused;
  - `own` inside against outside, reading like missing;
  - a race in which the patient leaves the scope while the change waits for the plan row;
  - revocation.
- Creation entry:
  - 409 inside the scope;
  - outside reads like missing;
  - without the grant, refused.
- Collection:
  - the instalment with its invoice and audit, and replay;
  - the approved agreement's collection;
  - `clinical.plans.edit` and view grants refused;
  - outside reads like a missing plan;
  - revocation.

## 11. Slice 94c — plan items and consent (G4-1, G4-8)

This section is written before the code.

| Route | Legacy | Canonical |
|---|---|---|
| `POST /api/plans/[id]/items` | A doctor (own patients, plan-edit switch) or the money roles. The price is the catalogue price on a base-currency plan. An agreement-currency plan requires an explicit price, checked against the catalogue: discount within the ceiling with a reason for non-admins, increase admin only. Audits `plan.item_add` (and `plan.price_override`) **after** the commit. | `clinical.plans.edit`. Prices by grants (G4-1): `finance.discounts.apply` within the ceiling with a reason, `finance.discounts.override` beyond it, `finance.price-increases.apply` above the catalogue. One admitted operation on `addPlanItemOn`; both audits **in the same transaction**. |
| `PATCH /api/plans/[id]/items` (sessions, billing rule, doctor, note) | Same roles; `updatePlanItem` audits in its transaction. | `clinical.plans.edit` on `updatePlanItemOn`. |
| `DELETE /api/plans/[id]/items` (before consent only) | Same roles; `removePlanItem`. | `clinical.plans.edit` on `removePlanItemOn`. |
| `POST /api/plans/[id]/consent` (and an optional instalment schedule) | Money roles. Two transactions: the consent is committed, then the schedule; a schedule refusal answers 409 «سُجّلت الموافقة، وتعذّرت الجدولة». An invalid count or interval was refused only **after** the consent had been committed. | `clinical.plans.edit` (the map's grant). The count and interval are validated **before** anything is written (stricter: a malformed request no longer leaves a consent behind). The consent and the schedule run in one admitted operation. A schedule refusal keeps the consent: that state is committed and the same 409 is returned, as legacy. A thrown error rolls both back. |

### Scope and locks

Every writer takes `lockPlan`: the patient row, then the plan row. The scope is decided right after both locks:
- an `own` actor needs a positive ownership witness `FOR SHARE NOWAIT`, held until commit;
- a lock conflict is 409;
- outside the scope, a plan reads like a missing plan.

An early unlocked look comes first. The legacy wrappers run the same `…On` functions in their own transactions, through one runner that commits only an `ok` result.

### What decides nothing

- Role labels.
- The legacy `canEditPlans` switch.
- View grants.
- The price grants without `clinical.plans.edit`.

### Tests required before the commit

- Add at the catalogue price with both audits in the transaction.
- An agreement-currency explicit price, each way:
  - without a price grant, refused;
  - a discount within the ceiling with a reason, by `discounts.apply`;
  - beyond the ceiling, by `override`;
  - an increase, by `price-increases.apply`.
- Update and delete with their legacy guards.
- Consent:
  - with a schedule;
  - a schedule refusal keeps the consent (409);
  - a malformed schedule writes nothing.
- View grants and the label refused.
- `own` outside reads like missing.
- A race in which the patient leaves the scope while the writer waits for the plan lock.
- Revocation.
