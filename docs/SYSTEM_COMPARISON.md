# System comparison and single-source decisions

Date: 2026-08-27  
Implementation repository: `Aqlanf10/aqlan-center-mini`  
Reference snapshot: `Aqlanf10/aqlan-dental@34c2b4e`  
Overlapping prototype snapshot: `Aqlanf10/aqlan-center@38b2347`

## Repository roles

| Repository | Role | Allowed use |
| --- | --- | --- |
| `aqlan-center-mini` | The only implementation and production source for this project | Schema, migrations, UI, server actions, tests and documentation |
| `aqlan-dental` | Read-only description of the established clinic workflow | Learn business rules and owner terminology; never share code, secrets, data or runtime dependencies |
| `aqlan-center` | Read-only overlapping prototype | Use only to identify candidate requirements; never merge it or implement a second production path |

This boundary prevents three applications from independently defining patient balances, voucher states and daily-clinic rules.

## Capability map

| Capability | Established system behaviour | Current mini implementation | Decision / owner |
| --- | --- | --- | --- |
| Authentication and staff | Users, roles and server-enforced permissions | ADMIN, DOCTOR and RECEPTION with server guards and session revocation | Keep. `src/lib/auth` is the only RBAC owner. |
| Patients | Searchable patient record with clinical alerts and history | Search/create/edit/archive, duplicate warning and file-number sequence | Keep and extend only through the patient domain. |
| Appointments and daily flow | Booking, conflict protection, arrival, queue, chair/call workflow and visits | Appointment state machine, Today page, visits and follow-up; no chair/call display | Keep the current cycle. Chair/queue-display is a future owner-approved phase, not a parallel visits table. |
| Clinical work | Visit treatment details and specialty records | Structured visit work items using one service catalogue | Keep. `visit_work_items` is the single daily-production source. Advanced orthodontic/AI records are out of current scope. |
| Service catalogue | Reusable, archivable services and prices | Admin-managed bilingual catalogue with default prices | Keep. Do not introduce a second invoice-service table. |
| Patient billing | Invoices, line items, discounts, collections and refunds | Legacy `charges`/`payments`; work items do not automatically bill | Preserve current ledgers. Design invoices as a later additive phase; do not silently equate production value with patient debt. |
| Treasury | Mandatory cashier sessions, per-currency counted closing | Per-currency cash accounts, receipt/payment vouchers and daily closing; no cashier session | Keep voucher ledger. Cashier sessions need a separate ADR before implementation. |
| Currency | Payment-time exchange-rate snapshot plus native amounts | Native YER/SAR/USD balances are never mixed; no base-currency conversion | Keep native balances. Exchange rates/base-currency statements require an owner decision and cannot be retrofitted implicitly. |
| Receipt reversal | Append-only refund/reversal; original remains auditable | Original payment is retained and a linked negative payment restores the balance | Fixed and protected by PostgreSQL integration tests in phase 0007. |
| Voucher concurrency | A financial document must be reversed once | Row locking plus a database-unique reversal target | Fixed in 0007; both application and database reject a second counterpart. |
| Expenses and payables | Expense vouchers; lab/supplier liabilities recorded separately from settlement | Payment vouchers, lab cases and supplier purchase invoices with balances | Keep. A payable and its payment remain distinct documents. |
| Doctor commissions | Collection-based and work-based settlement rules | Snapshotted plans, PENDING/APPROVED/PAID/REVERSED, linked vouchers | Keep. Payment, state transition and audit commit atomically; one active payout is enforced in PostgreSQL. |
| Accounting | Double-entry journals, trial balance, statements and period locks | Operational subledgers and cash reports; no general ledger | Do not copy the prototype ledger. Produce an ADR and reconciliation design before adding double entry. |
| Reports | Daily/monthly operations and financial statements | Dashboard, daily work, daily closing, period report and party statements | Keep shared domain queries as the source for screen and print output. |
| Printing/export | Receipts, vouchers, statements and operational reports | A5 vouchers and A4 statements/reports with print audit | Keep. CSV/backup export is a separate operations phase. |
| Audit and retention | Financial and clinical history is retained | Same-transaction audit support, archived clinical records and append-only corrections | Keep and strengthen with database constraints. |
| Voucher register party display | A payment voucher names its beneficiary (doctor/lab/supplier), distinct from its creator | Register and print use separate doctor/lab/supplier/creator joins | Fixed 2026-08-27: `listVouchers` joins party and creator aliases separately; regression-tested. |
| Lab/supplier balances | One derived balance per party per currency | `getLabBalance`/`getSupplierBalance` derived through `getLabBalances`/`getSupplierBalances` | Unified 2026-08-27: statements, finance screen, period report and print views all consume the same domain query; reconciliation-tested. |
| Visit lifecycle atomicity | Start/complete are single clinical moments | `visits/core.ts`: start, create, save-draft and complete each run as one transaction with row locks, in-tx audits and an `alreadyCompleted` domain result | Fixed 2026-08-27: concurrent completions produce one completion, one next appointment, one audit; race tests in `tests/integration/visits-atomicity.test.ts`. |

## Anti-duplication rules

1. One concept has one domain owner. Pages render domain queries; they do not recompute balances.
2. `charges` and `payments` remain the patient subledger. `vouchers` remains the treasury document ledger.
3. A patient receipt creates one voucher plus one linked payment atomically. Its reversal creates a new voucher plus a new linked negative payment atomically.
4. Lab and supplier liabilities are not expenses paid twice: the originating document creates the liability and the voucher settles it.
5. Work value, patient billing and cash collection are separate facts and must never be inferred from one another without an explicit workflow.
6. New database changes are additive migrations. Applied migration `0006` is immutable.
7. The UI, printable view and reports must reuse the same server query for each balance or register.
8. No work is performed in `aqlan-center`; useful requirements are re-specified and tested in this repository.
9. Visit lifecycle logic lives only in `visits/core.ts`; actions are thin auth/validation/revalidation wrappers and must never re-implement a transition.
10. Audit rows for critical movements are written inside the movement's transaction (see the classification in `TECHNICAL_DEBT_GUARDRAILS.md`).

## Decisions still requiring the owner

- Whether every patient charge must be represented by a formal invoice with line items.
- Whether cashier shifts become mandatory before accepting receipts or payments.
- Whether reports need a base YER equivalent using a payment-time exchange-rate snapshot.
- Whether full double-entry accounting and locked accounting periods belong in this lightweight application.
- Whether the public booking request and waiting-room chair display should be added after the financial ledger is hardened.
