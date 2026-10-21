# Treatment agreement amendment — guarded implementation handoff (Draft)
Base: `2667b71f815ee14781cdac6b37ebad3b4f8e246d` (main, verified 2026-10-21).
Branch: `feat/agreement-delta-amendment-20261021`.
Prohibited PR branches #380, #383, #386, #388, #389 are untouched.

## Current stage: **NOT IMPLEMENTED / DO NOT DEPLOY**
The new pure quote and unit tests are only a contract. There is **no posting API, schema,
ledger integration, visible patient screen, checkout guard or accounting reconciliation**.
They must not be presented as a completed feature or treated as acceptance.

## Reviewed, existing sources
- `lib/invoice-revision-db.ts` corrects by replacing an entire invoice and updating
  associated plan items, which is NOT the desired append-only delta event.
- `lib/invoice-identity-amendments.ts` deliberately refuses changing treatment
  identity after settlements or protected clinical work. Do not remove that guard.
- `migrations/0064_approved_agreement_principal.sql` freezes financial principal,
  original invoice lines and plan terms, and rejects a second full-principal invoice.
- `lib/approved-agreements.ts`, `lib/debt-installments-db.ts`,
  `lib/invoice-settlement-position.ts`, `lib/debt-account-position.ts`,
  `lib/plan-financial-position.ts` and `lib/checkout-due-recommendation-db.ts`
  independently project balances from existing source evidence. A new event must
  be consumed by ALL relevant readers, statements and historic as-of reports.
- The policy engine is `lib/commission.ts`: it selects historical effective policy
  and accounts for materials/lab deductions. No independent percentage calculation
  or automatic entitlement for an unresolved cost allocation is allowed.
- Draft #389 only clarifies refusal/history and must not be cherry-picked.

## Necessary atomic implementation contract (blocking)
1. Versioned, immutable, explicitly plan/item/source-linked delta rows, with
   idempotency uniqueness and immutable response receipt. Keep clinical history,
   original invoice/line IDs, receipts, refunds, audit and paid payroll unchanged.
2. A single SERIALIZABLE or ordered-lock transaction checks current admin
   authority, verified settlement provenance, plan and visit ownership, all
   overlapping drafts, source-hash freshness and the historic cut-off date.
   Require explicit new service ID. Commit delta, new current agreement snapshot,
   audit, patient debt evidence and receipt together; rollback on any error.
3. Preserve time-sliced principal projections and every existing statement
   report. New current net = prior net + delta; refunds immediately decrease net
   settled amount. Never derive allocated credit from an unrelated bucket.
4. Reuse existing commission effective-date policy and allocation lineage; post
   difference commission **pending_cost_evidence** until expense attribution is
   verified, preventing double lab/material deduction or payroll payout.
5. Connect exact plan, case, visit, checkout, bill-once guard, signed-work
   protection and the visible agreement editor. Preview old/new/delta/verified
   payments/remaining and preserve body+key across uncertain HTTP outcomes.
6. Run real PostgreSQL 18, HTTP, overlapping transactions/retries, admin
   permissions, historical as-of statements, discounts/refunds/FX, cashbox,
   commission policy changes and browser checkout before unlocking this Draft.

No production data or secrets were used, no migration was introduced, and no
service or production state was changed.
