# td05 clinic-day fixture: deterministic same-day and next-day cases

## Defect
`__tests__/security-http/td05-currency-safety-2.test.ts` (blob `a92db08d` on `main` `2667b71f`, #428 and #429) failed in hosted CI when it ran in the last ~18 minutes before Asia/Aden midnight (20:42–21:00 UTC):
- #429 run 39848680214;
- #428 run 39843543374.

### Cause
- **What the fixture did:** `linkedVisit()` inserted each visit at `NOW() + 60..1059 s`.
- **The product rule:** the checkout prior reference (`visitWalkoutInSnapshot`, `lib/db.ts`) excludes receipts whose Aden clinic date equals the visit's arrival date.
- **What went wrong:** near midnight, the future arrival landed on the next clinic day. The 2,000 USD receipt then correctly became a prior-day payment, and the prior USD reference netted to 0. A zero row is not rendered, so the assertion `exactMoney(previous-balance, USD, "2,000.00")` saw 0 rows.

The product rule is unchanged. Only the fixture inherited the clinic day from the wall clock.

## Fix (tests only)
- **Collection journey (test 2):** after the 2,000 USD receipt is saved, the visit's arrival is pinned to that receipt's instant. The page is then re-read through the real request path. "Previous 500 / current 0" is now a same-day relationship by construction.
- **Separate-currency journey (test 4):**
  - before signing, the arrival is pinned to the receipt's instant, so it is the same clinic day by construction;
  - all original assertions are kept: previous USD 2,000.00, current USD 1,500.00, YER 25,000, SAR 1,800.00, and no 3,000 total;
  - a deliberate **next-day control** follows: the arrival is moved exactly +24 h (Aden has no DST), and after a reload the previous USD row is absent (it nets to 0), while current USD 1,500.00, YER 25,000 and SAR 1,800.00 stay separate.
- **Visit selection is unchanged:** the explicit `?visit=` navigation and `linkedVisit()` ordering are as before.
- **`__tests__/postgres/checkout-clinic-day-boundary.test.ts`:** reader-level control with **fixed** instants around one Aden midnight. Nothing reads the wall clock.
  - Receipt at 23:59:30, arrival at 23:59:50 → prior USD 2,000, current 1,500, today's receipts USD 2,000.
  - Arrival at 00:00:10 the next day → prior USD 0, current 1,500, no receipts today.
  - YER and SAR are identical in both cases.

## Evidence (local PostgreSQL 18, synthetic data, built app on `main` + this change)
| File | What it shows |
|---|---|
| `old-fixture-next-day-fails.log` | The **old** test, with only the separate-currency visit moved to the next clinic day: the same hosted failure (line 302, `expected +0 to be 1`, 31.1 s). |
| `fixed-fixture-next-day-passes.log` | The **fixed** test under that same next-day manipulation of `linkedVisit()`: 8/8. Pinning to the receipt overrides the wall-clock arrival. |
| `fixed-fixture-run1.log`, `fixed-fixture-run2.log` | The fixed test unmodified: 8/8 twice, including the next-day control. |

The reader test passed 2/2. A later green run at another hour is not, by itself, the evidence for this fix.
