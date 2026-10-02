# Automatic laboratory order treating-doctor attribution

## Defect and bounded repair

Signing a visit already resolves and freezes the treating doctor on each procedure
and invoice line. `createAutoLabOrders` discarded that resolved doctor while
mapping the procedures, and neither insertion path wrote `lab_orders.doctor_id`.
The commission engine then correctly applied its existing legacy fallback to the
visit doctor, but for a multi-provider visit that could be the wrong provider for
the laboratory work. Accounting updates cannot recover the missing provenance.

The repair copies the resolved `ProcedureLine.doctorId` onto **new** automatic
orders, both with a tooth and without one. There is no new doctor inference,
commission formula, database migration, backfill, or change to order deduplication.
Existing manual orders and existing automatic orders, including NULL doctor IDs,
are not rewritten. The legacy NULL-order commission fallback remains unchanged.

## Real PostgreSQL reproduction

The regression uses application writers in this order:

1. Save a visit assigned to doctor A, with A's filling of 40,000 YER minor units
   and doctor B's crown of 60,000
2. An administrator finalizes the visit; A's commission rate is 30%, B's 40%
3. Set the automatically created order's cost to 20,000 YER minor units through
   `updateLabOrderAccounting`
4. Progress it through sent, received, and delivered with `setLabOrderStatus`
5. Record a 100,000 YER payment through `recordPayment`
6. Read the canonical `commissionReport`

Before repair, the lab order has no doctor, A's commission is 6,000 and B's is
24,000: total 30,000, with no non-deducted-cost warning. After repair, the lab order
belongs to B, A's commission is 12,000 and B's is 16,000: total 28,000. Procedure
and invoice attribution stays unchanged. The same result is tested with and
without a tooth code. These are synthetic local fixtures; no historical or
Production impact has been measured.

## Caller semantics preserved

- An explicit procedure doctor is retained, including an inactive doctor or one
  with a zero commission rate; the repair does not substitute another doctor
- When no explicit doctor exists, sign-off's existing valid visit-doctor then
  signing-doctor resolution remains authoritative
- The administrator finalizer, accountant, cashier, and laboratory status actor
  do not replace an already resolved treating doctor
- Free and installment-included work may remain unattributed; NULL stays NULL
- Priced non-included work without any resolved treating doctor remains refused
- Repeated or simultaneous signing creates no extra invoice or lab order
- A later session of the same planned crown does not replace the first order's
  provider or create another order
- Existing NULL automatic orders retain the legacy visit-doctor cost fallback;
  existing manual tooth orders remain unchanged

## Verification

`__tests__/postgres/auto-lab-doctor-attribution.test.ts` adds 17 real PostgreSQL
regressions. On the unchanged implementation, 11 failed and 6 preservation tests
passed. After the bounded repair, all 17 passed. The focused 9-file attribution,
commission, installment, and laboratory suite passed all 96 tests on PostgreSQL
18.4. Full repository checks and exact-commit CI are tracked in the pull request.

Historical NULL orders require a separate evidence-led review. This change neither
infers their missing doctor nor changes any historical amounts or commission rules.
