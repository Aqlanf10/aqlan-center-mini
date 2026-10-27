# Prepared patient consumption cost reader — 2026-10-26

This is a sourced, read-only core, not an operational endpoint. It adds no UI,
schema, stock/debt writer, doctor deduction, payroll rule or activation. The
canonical patient-cost authorization adapter is still missing; default principal
resolution and read authorization fail closed.

## Authorization and snapshot contract

`createPatientConsumptionCostReader` uses the shared stable realm/subject/actor
principal resolver. Its explicit `authorizeRead` dependency must apply the
canonical patient **and financial-cost** read policy and return the exact patient,
realm and subject binding. This is an integration seam, not a permission grant or
an administrator fallback. Tests inject synthetic bindings only.

Callers must own a REPEATABLE READ or SERIALIZABLE, READ ONLY transaction.
Autocommit, READ COMMITTED and writable transactions refuse. Live user ID,
username, role and active state are checked with a plain SELECT; no row locks are
attempted. Authorization and source evidence share that transaction's snapshot.
A later revocation or invoice cancellation becomes visible on the next snapshot;
callers must keep these transactions short. The report's `asOf` is the database
transaction timestamp. Existing dormant rollout/schema checks remain required.

## Evidence and valuation

Only `consumed` custody events with agreeing stored clinical columns/document,
verified patient/visit/case/procedure relations, an actual out movement, and one
matching item/lot/location/quantity allocation contribute. Duplicate use of one
movement, a quantity exceeding the original receipt, or inconsistent evidence
cannot create a known subtotal. Clinical discrepancies return a redacted missing
row without another patient's references. Patient-only evidence keeps a null
visit; the pure treatment summarizer now supports that explicit patient scope.
Historical doctor attribution remains missing: neither current custody ownership
nor a visit's doctor proves the doctor at consumption time.

A final known cost requires full receipt-lot coverage by immutable matched,
posted, uncancelled invoices in the validated realm, exact canonical payable
snapshots and receipt allocation lineage. Historical approved order versions,
receipt documents and recorded unit conversions are used. Later approved price
amendments, current item labels and current expiry do not reprice or erase
historical consumption. Ambiguous/missing historical versions fail closed.

The allocation rule is deterministic: invoice native line totals include saved
shipping/discount allocations; frozen base total is allocated across lines by
native line value; each line's native and base amounts are allocated across its
receipt portions by exact quantity atoms. Existing `allocateMinor` conserves
integer minor totals and resolves remainder ties by stable allocation IDs.
Every level checks conservation. Known timestamps use the latest contributing
immutable payable-link posting time; explicit saved order-quote estimates use
the original receipt creation time. Report time is separate. Successful invoice
valuation is cached only inside the current read snapshot and shared across lots.

Usage retains exact proportional fractions until the selected patient/currency
subtotal is rounded once. Per-row rounded amounts are display values, **not an
additive event cost ledger**. Native currencies have separate summaries; base is
YER using frozen invoice valuation, never current FX. No mixed-native SQL sum is
introduced. Existing quantity and money helpers retain their contracts.

Partial billing, unposted invoices, cancelled invoices, adjusted/mismatched
payables and incomplete lineage produce missing final valuation, not free cost.
Where no invoice allocation exists, a validated saved approved-order quote can
be shown as an explicit native estimate; its final base valuation stays missing.
Purchases, transfers, unissued inventory, unused returns and waste do not become
patient consumption. No service-based consumption is inferred.

There is no authoritative complete material-registration ledger. Every full
patient treatment total remains null/missing, including an empty patient record;
the known recorded subtotal and separate estimates remain visible. A 1,000-row
or source bound fails instead of returning truncated totals. The reader publishes
rows into summaries only after their validation and arithmetic finish.

## Verification and fixture provenance

Node 22.23.3, PostgreSQL 18.6; explicit loopback synthetic container
`aqlan-inventory-supplier-20261026`, port 54339, database `aqlan_p1_test`.
No real data or production environment was accessed.

Final composed PostgreSQL command:

```sh
npm run test:postgres -- \
  __tests__/postgres/inventory-patient-consumption-cost.test.ts \
  __tests__/postgres/inventory-supplier-finance.test.ts \
  __tests__/postgres/inventory-custody-transfer.test.ts \
  __tests__/postgres/inventory-command-lifecycle.test.ts \
  __tests__/postgres/inventory-procurement-store.test.ts
```

Result: **5 files, 99 tests passed, 41.90 s**, including 23 new reader cases.
Coverage includes full source lineage/no effects, patient-only and verified visit
attribution, split receipt conservation, scope rounding/mixed currencies,
cancellation and coherent concurrent snapshots, estimates/partial/unposted
sources, expiry/order amendment/unit-label stability, redaction and corruption,
realm/authorization/active-user checks, transaction/schema/gate refusal, limits,
and no cost for transfers, unused returns or approved waste. No-effect checks
compare full-row hashes of stock, allocations, usage, command/audit and canonical
financial tables. Corrupt evidence is seeded in rollback-only transactions,
switched READ ONLY before invoking the reader; append-only guards stay enabled.

Unit command selects `inventory-treatment-custody`,
`inventory-procurement-domain` and `inventory-custody-clinical-boundary`:
**3 files, 164 tests passed, 1.97 s**. The two added pure cases prove null-visit
patient scope and exact grouped fractional rounding. `npm run typecheck` passed.

Initial development runs exposed fixture currency-scale expectations, a wrong
revision argument and order-amendment fixtures that violated existing source
commitment guards. Reader SQL also referenced a nonexistent timestamp column and
needed explicit UUID/text parameter typing; these queries were corrected using
the existing persisted receipt source. Fixture corrections did not weaken
product guards. An initial committed
oversized-consumption fixture affected subsequent global custody balance checks;
final corruption fixtures are rollback-only. One exact synthetic compensation
was made during diagnosis, then all that disposable fixture history was archived
as `aqlan_p1_cost_fixture_history` and final runs used a fresh database.

The first fresh database name was rejected **before tests** by the existing
harness's exact `aqlan_p1_test` target contract. The old synthetic database was
renamed and the empty replacement renamed to the required name, without
terminating active sessions or bypassing the guard. A subsequent fresh focused
run passed 19/19 before the final four cases and composed run above. An earlier
unit command selected only two existing files (77 passed); the corrected final
three-file command above is the acceptance evidence.

Logs are preserved outside source under `/workspace/inventory-resume-evidence/`:
`cost-pg-composed-final.log`, `cost-unit-composed-final.log`,
`cost-typecheck-final.log`, `cost-lint-final.log`, `cost-money-final.log`, and
the numbered initial-run logs. Full `npm run lint` passed with zero errors and
209 existing warnings (none in these changed files); `npm run scan:money` and
`git diff --check` passed. Build, hosted CI and
synthetic database restore verification belong to the parent integration
step; this slice makes no claim that those have already run on these changes.
