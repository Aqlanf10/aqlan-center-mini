# Finance continuation: plan, results and resume point

Branch `feat/claude-work-continuation-20261110` (independent; stacked on the #506 head `8586f991`). This file is the resume point: update it at each step so the work can be picked up by any session.

## Rules in force

- Synthetic data only (`SYN-` prefix). No Production or Staging access, no deployment, no merge into `main`, WORK (#506) or any orthodontic branch.
- Dot owns orthodontics and cephalometry (#530, `feat/ortho-reconcile-20261109`, #532, #533). Do not edit those branches, the ortho/ceph files, or the test files those PRs touch. If a finance fix needs a shared file, record the overlap in section 4 and continue with independent work.
- Every fix: a test that fails without it, grants and patient scope preserved, money in integer minor units per currency, audit in the same transaction.
- One writer at a time in `lib/db.ts`. Review agents are read-only; their reports are leads, not evidence — each claim is re-verified in the code and by a test before it is acted on.
- Never run two PostgreSQL test runs at the same time on the local instance.

## 1. Done on this branch

| Commit | Content | Evidence |
|---|---|---|
| `aae4d721`, `8417afdb`, `44e85d1f` | Interim branch: plan-item financial-lineage privacy fix (Dot's P2 on #506) | Executed here for the first time: 8/8 with the fix; the new test fails with the fix reverted. |
| `4b3b2187` | Slice 95a: historical onboarding reads | PG 4/4 |
| `4424b90b` | Slice 95b: pre-system treatments | PG 5/5 |
| `817106ac` | Slice 95c: historical documents | PG 6/6, two mutations, related PG 837/837 |
| `bf0d3f1f` | Slice 95d: previous-balance arrangement; regenerated `inventory.json` | PG 4/4, two mutations, related PG 273/273. Full gate green; Draft PR #536. |
| `0c4cdd08` | Owner decisions of 2026-11-11: commission after the invoice discount; payroll pays the cumulative due (collection month); lab cancel shows "paid" only when fully settled; pure case-participation engine | Unit 20 new; PG 22 new (20 fail on the previous code); related PG 50 files, 834/834. Details: `commission-owner-decisions-20261111.md`. |

Gate finding on `817106ac`: the interim commits had not regenerated `docs/security/staff-cutover/inventory.json`; the readiness audit reported drift (2 unit failures). The regenerated file is committed with slice 95d. One more unit failure (`redirect-hardening`, a 5 s timeout under load) passes alone.

## 2. In progress

- Gate on `0c4cdd08` found that the generated `inventory.json` digest was stale again (source files changed, the file was not regenerated). Regenerated in the next commit; the rule is now: regenerate the audits before every commit that touches `lib/`, `app/` or tests.
- Case-participation storage (migration `0126`) is on its own branch, `feat/claude-commission-case-participation-20261111`, stacked on this one, so that its strict migration lists can be reconciled with the orthodontic candidate (#535/#537, lists end at `0125`) without touching this branch.
- Gate on `0c4cdd08`: unit 15,021/15,024 (two inventory-drift failures fixed in `9b2831a3`, one load timeout that passes alone); tsc pass; PostgreSQL 225 files, 2,958/2,958; build pass; HTTP journeys 807 passed with the three known local browser failures. Pushed at `9b2831a3`.
- Correction price and discount authority (review request 6801961109 on #483): implemented on canonical sessions; matrix, proven defect versus open policy and the five owner questions are in `correction-price-authority-20261111.md`. Unit 12/12; PostgreSQL 15/15 (12 of 15 fail on the previous writers); related PostgreSQL 25 files, 355/355. No policy was decided for the owner.

- Second review round (2026-11-11), on this branch after `b5c76e71`:
  - Price authority on corrections: the five rules approved by the owner are implemented; the manual-line cases were decided under the owner's delegation and by the owner principle (the owner can do everything and gives authority to whom he sees fit): raise or first price from zero needs the increase grant; a currency change or an unprovable reference needs the full price authority (increase and discount override together). Legacy corrections now record the price detail in their audit row. Details: `correction-price-authority-20261111.md`, section 4.
  - Discount remainders ordered by group identity; payroll draft capped at its own period end; the CI journey `verify-deletions` follows the approved lab rule. Details: `commission-owner-decisions-20261111.md`, section 5.
  - Evidence before the gate: unit `correction-price-authority` 18/18 and `commission-invoice-discount` 8/8; new and changed PostgreSQL files 5 files, 92/92; the payroll horizon test fails on the previous code; related PostgreSQL 71 files, 1,123/1,123; `npm run verify:deletions` green.
- Case-participation storage: pushed at `297f83cd`, Draft PR #539 (gate green except the three known local browser journeys).

- Gate evidence, 2026-11-12:
  - Hosted CI on `b5c76e71` (run 43108809004): quality job success; both built-app HTTP and hosted-browser shards success; contract print success; the PostgreSQL job failed only at "Operational verification journeys" (the `verify-deletions` lab journey, fixed in `1114e608`). Hosted CI on `297f83cd` (run 43118545704, PR #539): the same pattern.
  - The three browser journeys that fail locally (`agreement-reconciliation-browser` at 390 and 1280 px, `dental-chart-built-page` at 390 px) pass on hosted CI. Cause: the project pins Playwright 1.63.0, which expects Chromium revision 1243 (153.0); this environment only has revision 1194 (141.0) and may not install another. They are a local-environment limit, not a product defect; hosted CI is the authority for them.
  - The unit timeout in `ai-provider-api-security` (5 s) appears only inside the full local unit run under load; alone it passes, and the hosted unit step passes.
  - Local gate on `1114e608`: unit 15,044/15,044; lint 0 errors; audits 10/10; build pass. Two findings: `tsc` failed on a stale `.next/types` left by the previous head's build (clean after the fresh build), and `lab-status-financial-boundary` failed before any test ran because an earlier file left a stub `users(id)` table and the suite did not reset the schema (reproduced; fixed in `5357aba4`, test only).
  - The local gate now also runs `npm run verify:ci`, the operational journeys step that hosted CI runs and the local gate had been missing.

## 3. Finance queue (order by risk to patient balances and the cash box)

Three read-only audits ran on 2026-11-10/11, one per area (they stopped once at the usage limit and were resumed). Their reports are leads; the state column says what I verified myself.

| Id | Finding | Where | State |
|---|---|---|---|
| F2-1 | Cancelling a lab order whose payable has vouchers marks the order "paid" by counting voucher rows, even when the net settled is partial or zero (paid then voided). The order then hides from unpaid work while the laboratory is still owed. | `lib/db.ts` `setLabOrderStatusOn`, cancel branch | **Fixed locally** with `lab-cancel-payable-truth` (5 tests). "Paid" only when fully settled; otherwise the status stays `payable_created`. The payable and the amount owed are not changed. PG run pending (after the gate). |
| F2-2 | The same cancel counted vouchers without locking the payable; a payment committing between the count and the `DELETE` left a voucher linked to a deleted payable. | same | **Fixed locally** in the same change: `FOR UPDATE` on the payable before the count; race test included. |
| F2-3 | Whether the unpaid remainder of a cancelled, part-paid order is still owed to the laboratory. | — | **Owner decision.** Not changed: it stays owed and visible. A waiver would be an explicit negative `payable_adjustments` row. |
| F2-4 | No idempotency key on expense create: a double submit writes two vouchers. `expected` is optional for a payable payment. | `app/api/expenses/route.ts`, `lib/expense-request.ts` | Verified by reading. **Open:** needs a unique operation key (a migration; numbers 0090+ are reserved by other lines) — to schedule with the owner. |
| F2-5 | Payable create writes its audit row after the commit (best effort). | `app/api/payables/route.ts` | Verified by reading. **Open**, low: move to `insertAuditRow` in the transaction when the route is converted (slice 97). |
| F1-1 | A shift's opening float is free input, never compared with the previous shift's counted cash; cash that leaves or appears between shifts is in no voucher or journal entry. | `lib/db.ts` `openShiftWith` | Reported by the audit; **owner decision** (handover rule: refuse a mismatch, or record it as a deposit/withdrawal). Not changed. |
| F1-2 | A voucher can exceed the cash in the drawer; the close then books the gap as a cash surplus. Expenses carry no payment method. | `lib/db.ts` `recordExpenseInTx`, `lib/shift-close.ts` | Reported by the audit; **owner decision** (refuse above expected cash, or add a payment source to expenses). Not changed. |
| F1-3 | On the legacy session path, shift open and close commit before their audit row. The canonical path already writes it in the transaction. | `app/api/shifts/route.ts` | **Open**, low. |
| F3-1 | Payroll takes commission from `commissionReport(period.start, period.end)`, which is ranged by invoice date: a collection that lands after the invoice's period enters no payroll run (it shows only in the cumulative balance). | `lib/hr-payroll.ts` (calculate, approve, disburse), `lib/db.ts` `commissionReport` | Call and range confirmed by reading; **not yet reproduced by a test**. **Owner decision** on the rule (pay by collection date, or cumulative due minus prior payouts). High priority: doctor pay. |
| F3-2 | An invoice-level discount is not applied to the commission base: the share is taken on the pre-discount item totals. | `lib/commission.ts`, `commissionReport` | Reported by the audit; **owner decision** (who absorbs the discount). Not changed. |
| F3-3 | Unlinked legacy refunds reduce commission but not the material-cost base. | `commissionReport` | **Open**, low; old refunds only. |

Checked by the audits and reported sound: expected-cash arithmetic per currency, single open shift, close against in-flight payment/expense/void, overpayment and cross-currency guards on payables, symmetric void, integer minor units, clinic-timezone dates, role gates on shifts/expenses/payables/commissions/reports, the doctor party join for lab cost.

Canonical conversion still open in finance (from the route map): shifts and day close, expenses, treasury, payables, commissions, reports (29 methods). Confirmed defects are fixed first; conversion slices 96–98 follow in that order.

## 4. Overlaps with Dot's work

- None needed so far. `lib/db.ts` is shared with #530 only in the sense that both lines change it in different sections; finance fixes stay out of the ceph and ortho sections.
- Integration plan: `work-continuation-status-and-ortho-integration-plan-20261110.md`. Nothing is ported until Dot names a frozen head.

## 5. Open decisions for the owner

- Policy points 1–9 of contract section 15 (recommended defaults are implemented; the owner may change them).
- Correction price controls (93c). Financial responsibility for a case (G4-7).

## 6. How to resume

1. `git fetch origin feat/claude-work-continuation-20261110` and check the head against section 1.
2. Read section 2 for the step in flight, then section 3 for the next finding.
3. Local PostgreSQL 18 on port 54329; one PG run at a time. Gate scripts: unit + tsc + lint + audits, then the PG list, then build + HTTP journeys.
