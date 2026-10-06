# Opening-balance mutation preflight safety

This bounded correction strengthens the existing opening-balance API; it does not add a historical-receipt correction or manual legacy financial intake workflow.

## Defect and guard

The route checked whether an opening existed, its old amount/date, required correction reason, and old-period eligibility before entering the writer transaction. Another writer could change or create that currency row between those checks and the upsert/clear. Admin creates also lacked the patient-row fence used by reception, so two absent-row writes could both record an empty predecessor in history.

All canonical opening set/clear transactions now serialize on the patient before touching the currency row. Corrections use `FOR NO KEY UPDATE`, which is compatible with ordinary receipt foreign-key checks. Reception retains `FOR UPDATE`, but refuses an existing row without locking that row. An absent-row insert conflict never becomes an implicit correction, including a competing legacy import. The route passes its own checked amount/date, or explicit absence, to the transaction. A changed amount, date, or presence is refused with HTTP 409 before modifying the opening or its append-only history; no success audit is emitted. Reception's existing add-only refusal stays HTTP 403. Clear returns 404 rather than reporting/auditing success when its writer reports no row.

The optional preflight argument preserves existing internal callers. It is an API-request financial-precondition guard, not a browser-draft version token: it does not detect changes made before the route reads the opening or note-only changes. The amount/date comparison ensures the route's reason requirement, prior-date check, and prior-financial-value audit refer to the values actually changed. Current period-setting changes racing with a request remain a separate concern; this change does not claim transaction-wide period-lock enforcement.

## Lock order and preserved ownership

Patient → opening row → opening mutation/history. Corrections keep the patient foreign-key key compatible, preventing a lock cycle with an ordinary opening payment that already holds the opening row. Installment recovery retains its existing patient-before-opening-table ordering and tests unchanged. Currency ownership, receipt/refund targets, ledger computation, linked arrangements and case/plan data are unchanged. No payment, invoice, arrangement, schema, migration, adoption or Production data correction is introduced.

## Verification

- `opening-balance-mutation-route.test.ts`: actual route with mocked data/session boundaries; checked absence, original financial values, untrusted client-supplied snapshot, conflict/non-conflict responses, no false success audit, existing role/reason/period checks.
- `postgres/opening-balance-mutation-concurrency.test.ts`: real PostgreSQL absent-row serialization, checked-create/import collisions, amount/date/presence conflicts, every ordered set/clear pair, both directions of ordinary payment concurrency, exact currency isolation, append-only predecessor truth, missing-patient compatibility and no incidental financial records.
- Existing installment-recovery account-cap and lock-order tests remain byte-for-byte unchanged.

Local validation is DB-free only. Real PostgreSQL concurrency and the aggregate HTTP/security/release gates must pass on the exact PR head before merge.

## Historical-receipt correction remains blocked

An ordinary reversal changes current-shift cash even when historical money never entered that shift. Reclassifying such a receipt needs per-record and per-currency evidence plus the owner's accounting-policy decision. This guard neither performs nor enables a bulk history rewrite, payment retarget, paired adjustment, historical credit path or correction coordinator.
