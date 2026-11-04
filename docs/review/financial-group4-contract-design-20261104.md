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

## 3. Decisions for the owner (isolated; nothing is assumed)

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

## 4. Slices (each after its decision where one is listed)

| Slice | Content | Waits on |
|---|---|---|
| 88 | Patient account reads (ledger, statement, treatment-financial-context, debts list, legacy balance arrangement read, debt-repayment workspace) — **done** | — |
| 88b | Responsibility (the case's responsible doctor) | G4-7 |
| 89 | Visit money reads (billing preview, financial context, walkout) | G4-4 |
| 90 | Payment reads and collection (payments, attempts retire, defer) with the shift rule and request keys | G4-4 |
| 91 | Payment correction/void; debt repayment arrangements and collection — **done** | — |
| 92 | Invoice reads and archive | — |
| 93 | Invoice writes (create, patch, add-service, clinical preview), cancel, correct | — |
| 94 | Plan money reads and writes, financial approval, amendment, reconcile | G4-1 |
| 95 | Historical onboarding and documents | G4-2 |
| 96 | Price-free service catalogue; services and prices; service materials | G4-3 |
| 97 | Expenses, payables, parties, openings, FX, reconciliation, lab accounting | — |
| 98 | Accounting, financial and operational reports, executive, commissions | G4-5 |
