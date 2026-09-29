# Purchasing Gap Assessment

**Current state: `INTEGRATED_STOCK_PURCHASE`.** This is not full procurement.

**Flow today:**
- Inventory input `kind='in'`, with quantity, unit cost, expiry, `supplierPartyId` and `supplierDueDate`.
- When a supplier is chosen, **one transaction** creates the `inventory_movements` row and the supplier `payables` row, linked by `inventory_movements.party_id` / `payable_id` (migration 0017, unique `payable_id`).
- Payment uses the normal voucher, with a per-currency snapshot, over-payment guard and reversal.
- Verified in Scenario B (`__tests__/postgres/financial-reconciliation-scenarios.test.ts`) and `__tests__/postgres/stock-supplier-link.test.ts`.

## A. Present and working

| # | Capability | Evidence |
|---|---|---|
| A-1 | Stock purchase with a supplier: stock and payable in one transaction | 0017, `createInventoryMovement`, Scenario B |
| A-2 | Partial and full payment of the supplier invoice, over-payment refused, void by reversal | P0-2, Scenario B |
| A-3 | Supplier statement per currency (owed, settled, remaining) | `partyStatement` / `partyStatementTotals` |
| A-4 | Weighted-average cost; returns do not move the average | `lib/inventoryCost.ts`, `inventory_movements.is_return` |
| A-5 | Append-only movements; an adjustment needs a reason | 0005 guards, `validateMovement` |
| A-6 | Supplier advance (prepayment above balance): admin only, with a reason | P0-2 |
| A-7 | **Legacy supplier debt before go-live as an opening payable** (not a purchase) | FIA-1, 0030, Scenario C |

## B. Missing, and threatening money or stock correctness

| # | Gap | Risk | Recommendation |
|---|---|---|---|
| B-1 | A **cash** stock purchase (no supplier) has no cash voucher link. | Stock rises while cash is unchanged, unless the user separately records a voucher. That second entry can double-count or be forgotten. | Add a "paid in cash now" option to the purchase. It would create the movement, a payable and an immediately settling voucher in the open shift, in one transaction. That separates *cash purchase* from *credit purchase* and from *advance*, with no open payable left. |
| B-2 | The stock purchase payable is always **YER**. | A supplier invoicing in SAR/USD must be entered as YER, so the statement currency is wrong. | Add a currency to the purchase, with the payable in that currency and unit cost converted to base for WAC at the settings rate snapshot. |
| B-3 | **Purchase return to supplier**: no supplier credit. | Goods go back, the stock "out" is recorded, but the supplier invoice stays whole and is over-paid or over-stated. | Add a return flow: an `out` movement with `payable_id` plus an append-only credit on that payable (the same `payable_adjustments` pattern introduced for opening balances, generalised). |

## C. Workflow and UX (not money-critical)

- C-1: There is no purchase-order number or supplier invoice number field on a stock purchase; free text goes in `reason`.
- C-2: There is no multi-line purchase (one supplier invoice with several items). Today it is one movement per item, each with its own payable.

## D. Can be deferred

| # | Item | Why deferred |
|---|---|---|
| D-1 | Inventory as an **asset** account (capitalise on purchase, expense on consumption). | Purchases are expensed at purchase today (a periodic method), and valuation is a derived report. Changing it is an accounting-policy decision for the owner and the accountant. |
| D-2 | Purchase request → PO → approval → goods receipt → supplier invoice → three-way match. | A two-chair clinic with one storekeeper: the integrated stock purchase covers the money truth once B-1..B-3 are closed. |

**`FULL_PROCUREMENT_NEEDED_NOW = NO`.** Close B-1..B-3 first, each in its own small PR with PostgreSQL 18 tests.
