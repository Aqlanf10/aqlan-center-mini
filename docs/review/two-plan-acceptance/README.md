# Acceptance: two plans × two specialties × two doctors × two currencies

Mandate §8 asks for a patient with two plans, two specialties, two doctors and two currencies, and proof that no payment, commission, visit or invoice moves to the wrong case.

`__tests__/postgres/two-plan-two-specialty-acceptance.test.ts` builds that patient on **PostgreSQL 18** through the real write paths, with synthetic data only. **It changes no product behaviour.**

| Track | Flow | Currency | Specialty | Doctor | Price | Paid |
|---|---|---|---|---|---|---|
| A | invoice-first (`createLinkedInvoice` creates the plan item and case, then consent) | YER | endodontics (RCT #36) | endodontist, 30 % | 8,000,000 | in full |
| B | plan-first (`createPlanV2` + consent, then `createLinkedInvoice` reuses the consented item) | SAR | prosthodontics (crown #14) | prosthodontist, 40 % | 150,000 | 60,000 |

Each track gets its own visit: the procedure is linked to its plan item at price 0 and signed by its own doctor, so signing bills nothing new. The receipt is then recorded in the plan's currency.

## What is asserted
1. **Plans and cases:** two plans and two cases. Each invoice line carries its own doctor. Each plan item belongs to its own plan and case, and the case has the right specialty. Each plan keeps its own currency.
2. **Visits:** each signed visit holds only its own plan item and doctor. There are still exactly two invoices.
3. **Receipts and balances:** each receipt settles only its own invoice in its own currency. The per-currency ledger shows YER and SAR separately (billed, collected, due), and USD is zero.
4. **Visit sources:** each visit's financial context is `verified` and names no invoice or plan item from the other track. A **control visit** with work linked to no plan item or invoice stays not-verified and has no references: unresolved sources are not relabelled as covered.
5. **Commission:** it accrues only to the performing doctor, and only in that plan's currency. The partially collected SAR track earns less than its accrual; the fully collected YER track earns all of it.

## Observation (current behaviour, unchanged)
While a patient has an active plan, an invoice cannot open a second plan by itself. `reusableMaster` returns `incompatible_plan` when there is no single compatible plan (same currency, `per_procedure`, no consent or installments).

A second-currency plan therefore has to be created explicitly first (plan-first), or selected explicitly (`existingPlanId`). This is recorded as current behaviour, not a defect, and nothing here changes it.
