# Pending participation commission — WIP

This branch isolates the owner's no-hold decision for explicitly pending case participation. It marks affected commission details, reports and statements as under review, scoped to the doctor, currency and specialty. Approved invalid participation remains held; approved payroll is not silently rewritten. This is not the complete 0134 feature and must not be merged or deployed before review and full verification.

On the final product changes at `b0812008ce383ed514442b103d88e2a564294e07`, 10 PostgreSQL tests passed on an isolated synthetic database, including approved-payroll preservation; six inventory checks passed, and scoped lint had no errors and nine existing warnings. Fourteen unit tests and 34 related PostgreSQL tests passed on earlier code. Typecheck, browser and print journeys have not been completed on the final source. Integrating with grouped-lab and retired-0079 work requires fresh combined checks.

The 0134 WIP's both-settings-off fallback has not been authorized; it was not adopted here. One initial test was stopped after it was found to target the shared synthetic test database; later tests used a separate synthetic server. No real patient data or production connection was used.
