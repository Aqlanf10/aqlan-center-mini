# Finance & Daily Operations — Gap Analysis and Data Model

> Working branch: `feat/mvp-v1` · PR #1 (open, do not merge) · This document is the
> design baseline for the daily-operations + finance expansion requested by the owner.
> No production deployment or production migration happens without explicit owner approval.

## 1. Gap analysis (current state → required state)

| # | Area | Current state | Required | Phase |
|---|------|--------------|----------|-------|
| 1 | Auth secret | `AUTH_SECRET` falls back to a hard-coded development secret | Production must refuse to boot without `AUTH_SECRET` | 0 |
| 2 | Completed visits | A COMPLETED visit can be re-saved (history rewrite) | Completed visits immutable; corrections via audited append-only entries | 0 |
| 3 | Financial writes | charge/payment insert + audit log are two separate statements | One atomic transaction (movement + audit) | 0 |
| 4 | Double-submit | No idempotency; double click can create duplicate payments | Idempotency keys + DB uniqueness barriers | 0 |
| 5 | Visit↔appointment | No DB constraint; app logic only | Partial unique index: at most one visit per appointment | 0 |
| 6 | Financial tests | Unit tests only, no real PostgreSQL | Real PostgreSQL integration tests for critical finance paths | 0 |
| 7 | Services | `treatmentType` / `treatmentPerformed` free text — not aggregatable | Admin-managed service catalog (code, bilingual names, category, default price, currency, commission flags) + editable categories | 1 |
| 8 | Work items | None | Multiple structured work items per visit (service, doctor, qty, price, discount, total, notes, optional lab link) | 1 |
| 9 | Today screen | Appointments + statuses only | Completed-work summary by service & doctor with drill-down | 1 |
| 10 | Finance section | charges/payments only inside patient file | Independent «المالية» section with server-side RBAC | 2 |
| 11 | Treasury | No cash/bank accounts | Cash/bank accounts per currency (no currency mixing) | 2 |
| 12 | Receipt vouchers | None | `RCPT-YYYY-NNNNNN` numbered receipt vouchers (patient or other party) | 2 |
| 13 | Payment vouchers | None | `PV-YYYY-NNNNNN` numbered payment vouchers (doctor/lab/supplier/general expense) | 2 |
| 14 | Voucher corrections | N/A | Append-only after approval; reversal entries with mandatory reason + audit | 2 |
| 15 | Expense categories | None | Admin-managed expense categories | 2 |
| 16 | Legacy data | `charges` / `payments` are the patient ledger | Preserved untouched; new patient receipts create voucher **and** payment atomically (1:1 link) so old and new balances always match | 2 |
| 17 | Doctor commissions | None | Per-doctor plans (percent/fixed, per-service overrides, basis = work value or collected), snapshot at creation, PENDING→APPROVED→PAID/REVERSED | 3 |
| 18 | Lab accounts | None | Labs directory, lab cases linked to patient/visit/doctor/service, invoices, payments via payment vouchers, balances | 3 |
| 19 | Suppliers & materials | None | Suppliers + materials directories, multi-line purchase invoices, payments via payment vouchers, statements (no full inventory — tables designed so stock can be added later) | 3 |
| 20 | Reports | Aggregate cards only | Daily closing, daily work, period financial, statements, registers, per-category expenses — per currency, never mixed | 4 |
| 21 | Printing | None | Print pages (A5 vouchers, A4 reports) with clinic identity, RTL-correct, print-audit | 5 |
| 22 | RBAC granularity | Finance = ADMIN+DOCTOR | ADMIN full; RECEPTION patient receipts + print only; DOCTOR own work & commissions only | all |

## 2. Proposed data model

New tables (all cumulative migrations, no destructive changes):

```
Phase 0/1 — drizzle/0006:
  idempotency_keys(key PK, scope, entity_id, created_at)
  service_categories(id, name_ar, name_en, active, sort_order, timestamps)
  services(id, code UNIQUE, name_ar, name_en, category_id FK, default_price numeric(12,2),
           currency, commission_eligible bool, default_commission_type, default_commission_value,
           active, timestamps)
  visit_work_items(id, visit_id FK, service_id FK, doctor_id FK, quantity numeric(10,2),
                   unit_price numeric(12,2), discount numeric(12,2), total numeric(12,2),
                   currency, notes, status ACTIVE|CANCELLED, created_by, timestamps)
  visit_corrections(id, visit_id FK, note, reason, created_by, created_at)  -- append-only
  + partial UNIQUE INDEX visits(appointment_id) WHERE appointment_id IS NOT NULL

Phase 2 — drizzle/0007:
  cash_accounts(id, name, currency, type CASH|BANK, active, timestamps)
  expense_categories(id, name_ar, name_en, active, timestamps)
  voucher_counters(kind RECEIPT|PAYMENT, year int, last_number, UNIQUE(kind, year))
  vouchers(id, type RECEIPT|PAYMENT, voucher_number UNIQUE, party_type PATIENT|DOCTOR|LAB|SUPPLIER|OTHER,
           patient_id?, doctor_id?, lab_id?, supplier_id?, lab_case_id?, purchase_invoice_id?, commission_id?,
           other_party_name?, expense_category_id?,
           amount numeric(12,2) CHECK>0, currency, cash_account_id FK, payment_method CASH|TRANSFER|CARD|OTHER,
           voucher_date timestamptz, description, reference, status ACTIVE|REVERSED,
           reversal_of_voucher_id? (self FK), reversal_reason?, created_by FK, approved_by?, timestamps)
  payments.voucher_id → vouchers(id) (nullable, 1:1 link for patient receipts)

Phase 3 — drizzle/0008:
  doctor_commission_plans(id, doctor_id FK, service_id? FK (NULL = doctor default), basis WORK_VALUE|COLLECTED,
                          type PERCENT|FIXED, value numeric, active, timestamps)
  commissions(id, doctor_id, work_item_id?, source_voucher_id?, basis, plan_type, plan_value,
              base_amount numeric, currency, amount numeric?, status PENDING|APPROVED|PAID|REVERSED,
              paid_voucher_id?, approved_by?, approved_at?, reversal_reason?, reversed_at?, created_by, timestamps)
  + partial UNIQUE(work_item_id) WHERE basis='WORK_VALUE'
  + partial UNIQUE(work_item_id, source_voucher_id) WHERE basis='COLLECTED'

Phase 3 — drizzle/0009:
  labs(id, name, phone?, address?, notes?, active, timestamps)
  lab_cases(id, case_number UNIQUE LC-YYYY-NNNNNN, lab_id FK, patient_id FK, visit_id?, doctor_id FK,
            service_id?, work_type, cost numeric(12,2), currency,
            status ORDERED|SENT|RECEIVED|DELIVERED|CANCELLED,
            sent_at?, expected_delivery_at?, delivered_at?,
            invoiced bool, invoice_number?, invoice_amount numeric?, invoiced_at?,
            notes?, created_by, timestamps)

Phase 3 — drizzle/0010:
  suppliers(id, name, phone?, address?, notes?, active, timestamps)
  materials(id, code UNIQUE, name_ar, name_en, unit?, default_supplier_id?, active, timestamps)
  purchase_invoices(id, invoice_number UNIQUE PINV-YYYY-NNNNNN, supplier_id FK, supplier_ref?,
                    invoice_date, currency, total_amount numeric, status ACTIVE|CANCELLED,
                    cancel_reason?, created_by, timestamps)
  purchase_invoice_items(id, invoice_id FK, material_id FK, quantity numeric(10,2),
                         unit_price numeric(12,2), discount numeric(12,2), total numeric(12,2))
```

## 3. Key invariants

1. **Currencies are never mixed.** Every report groups by currency; no cross-currency totals.
2. **Voucher currency must equal its cash account currency** (validated server-side + integration test).
3. **Vouchers are append-only after creation.** The only mutation is reversal: a counterpart voucher row (same type, linked via `reversal_of_voucher_id`, mandatory reason) + original marked `REVERSED`. Nothing is deleted.
4. **Patient balance continuity.** `payments` remains the patient-collection ledger. A patient receipt voucher inserts voucher + payment in the same transaction (linked by `payments.voucher_id`). Balance before/after migration is identical by construction.
5. **Treasury starts at zero** at module go-live; legacy payments (pre-treasury) remain visible in the patient ledger and in daily-closing transparency lines, but are never back-filled into invented cash accounts.
6. **Commission snapshots.** The plan (type + value) is copied onto the commission row; later plan edits never change existing commissions.
7. **Commission uniqueness.** One WORK_VALUE commission per work item; one COLLECTED commission per (work item, receipt voucher).
8. **Unconfigured plans ⇒ PENDING with no amount.** No entitlement, no payment, until ADMIN configures/approves.
9. **All money** is `numeric(12,2)` in PostgreSQL; application math uses integer minor units (`src/lib/money.ts`).
10. **Every sensitive action** writes an audit row in the same transaction as the movement.

## 4. Permissions matrix

| Capability | ADMIN | RECEPTION | DOCTOR |
|---|---|---|---|
| Services & categories management | ✔ | — | — |
| Cash accounts, expense categories | ✔ | — | — |
| Create patient receipt voucher + print | ✔ | ✔ | — |
| Receipt register (all) | ✔ | ✔ (create+list+print only) | — |
| Create/reverse payment voucher | ✔ | — | — |
| Reverse any voucher | ✔ | — | — |
| Daily closing, period report, registers | ✔ | — | — |
| Patient statement print | ✔ | ✔ | — |
| Commissions: plans, approve, pay | ✔ | — | — |
| View own work + own commissions | ✔ | — | ✔ |
| Labs & lab cases | ✔ | — | — |
| Suppliers, materials, purchase invoices | ✔ | — | — |
| Doctor/lab/supplier statements | ✔ | — | — |
| Visit corrections (append-only) | ✔ | — | — |

Server-side enforcement via `requireRole` in every page + action; queries filter by the acting doctor for `/my-work`.

## 5. Migration / backfill plan for existing charges & payments

1. `charges` — untouched. Still the patient billing ledger.
2. `payments` — untouched except one added nullable column `voucher_id` (FK to vouchers). Existing rows keep `voucher_id = NULL` (pre-treasury history).
3. After migration, a verification query asserts for every patient:
   `SUM(charges) - SUM(payments)` (old logic) == new balance logic (same tables) — trivially true because the ledger tables are the same; additionally the integration test replays: legacy payment rows inserted before the finance migration survive and keep patient balances identical.
4. Daily closing shows a separate transparency line for pre-treasury patient collections (payments with `voucher_id IS NULL` inside the day) so old movements are never hidden and totals reconcile without inventing treasury history.

## 6. Owner decisions still open

- Default cash accounts seeded at migration (one per currency, type CASH, editable/archivable) — replace/rename as desired.
- Commission generation is conservative: WORK_VALUE basis generates on visit completion; COLLECTED basis generates only for receipts explicitly linked to a work item. Unlinked receipts never create commissions automatically.
- Work items do **not** auto-create patient charges (billing stays explicit). Daily work report shows production value; charges/payments show billing reality.
- No ACCOUNTANT role added (not requested; RBAC stays 3 roles).
