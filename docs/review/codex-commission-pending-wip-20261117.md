# Pending participation commission — WIP

This branch isolates the owner's no-hold decision for explicitly pending case participation. It marks affected commission details, reports and statements as under review, scoped to the doctor, currency and specialty. Approved invalid participation remains held; approved payroll is not silently rewritten. This is not the complete 0134 feature and must not be merged or deployed before review and full verification.

On the final product changes at `b0812008ce383ed514442b103d88e2a564294e07`, 10 PostgreSQL tests passed on an isolated synthetic database, including approved-payroll preservation; six inventory checks passed, and scoped lint had no errors and nine existing warnings. Fourteen unit tests and 34 related PostgreSQL tests passed on earlier code. Typecheck, browser and print journeys have not been completed on the final source. Integrating with grouped-lab and retired-0079 work requires fresh combined checks.

The 0134 WIP's both-settings-off fallback has not been authorized; it was not adopted here. One initial test was stopped after it was found to target the shared synthetic test database; later tests used a separate synthetic server. No real patient data or production connection was used.

## Follow-up verification

On product source `ac16acad29092d033036e15d6076b81bf0593f3b` (the commit above changes only this review document), Node 22 typecheck passed. An isolated PostgreSQL 18 server passed all 11 participation cases, including a new simultaneous approval race on a pending head. Its strengthened rerun verified that exactly one decision wins, the computed commissions follow that decision only, and the already approved payroll item remains unchanged (1 passed, 10 deliberately unselected). Two added test files passed scoped lint.

A fresh Next 16.4.5 **compile-mode** build and local system Chromium exercised the new review marker on the live commission panel, the statement page, and text extracted from a generated PDF. It also checked that filtering to a different doctor or specialty omits the item (1 passed, 17 other cases unselected). The first compile attempt failed because an external `node_modules` symlink was outside Turbopack's root; a clean locked local `npm ci` resolved it. These are focused synthetic tests, not a full production build, full browser suite, integrated 0079 acceptance or a completed 0134.
