# Visit evidence on the merged financial foundation

Inputs pinned before composition:

- Existing #380: `2bb343f6906297672b13ebeb9a0fd7d0cac40cf7`.
- Main foundation: `9e8fd301ebcdee1197b75bc6d182861ff35712b8`.
- Reviewed #387 increment: `9e8fd301..8deabedb82abb227b1ee7472123b054b900d883c`.
  This consists of source `fc50eb3b94d6616a313e5496fe04ee58824d3fca` and
  evidence `8deabedb`; the later supplemental workflow is excluded.

The main merge is `ddaa4229ab11b4d034537fdbc810c12eedb5d022`.
Both reviewed increment commits were cherry-picked. Every increment blob matches
its reviewed source. All workflow files remain identical to pinned main.
Stable patch IDs for lib/db.ts, lib/reports.ts, components/ClinicalVisit.tsx and
app/visits/[id]/page.tsx match the original #380 runtime delta against its merge
base. No source-context batching/identity or assistant-navigation additions from
#383 and no #386 OCR/workflow changes were imported.

## Reproduced integration failure and limited fixture repair

The monthly witness brought by main had a smaller session-TEMP schema than the
new legitimate loadVisits query requires. All three tests failed with PostgreSQL
error `relation "visit_procedures" does not exist` in the isolated PGlite engine:

1. `distinguishes discounted document, unpaid payable, later partial payments and refund at clinic midnight`
2. `delivers identical measurement disclosures and amounts through API, screen and print without writes`
3. `keeps comparison labels aligned and expense reversals on their recording date`

Only __tests__/reports-monthly-measurement.test.ts was adjusted: invoke the already
reviewed REPORT_VISIT_TEMP_SCHEMA helper (visit_procedures plus services.name),
include the table in fixture cleanup and include its content in the before/after
nonmutation fingerprint. All existing money, time, currency, API and renderer
assertions remain unchanged. search_path=pg_temp and no production reads/writers
remain unchanged. This is fixture alignment, not an arithmetic repair.

## Validation environment and limits

Fresh private synthetic PostgreSQL 18.6 on loopback only. No production database,
migration command, Chromium, deployment or main merge was executed here.
Node 22.23.3 is the required validation runtime. Initial local attempts used the
host default Node 24 and linked node_modules: the link tripped the preflight
import boundary, and Node 24's reporter format tripped two restore wrapper
assertions despite their child tests succeeding. Those runs are not acceptance.
Physical local dependencies and Node 22 resolve these setup failures without
changing any guard, assertion, timeout or workflow.

Docker exported the context using the unchanged .dockerignore. The filtered
context contains no __tests__. Local lockfile dependencies were physically
copied into it; Next production build, preflight packaging and runtime braces
verification ran on Node 22. This is a Docker-filtered build, not an actual
final-container-image test. Hosted exact-head HTTP/browser acceptance remains
required; prior runs and independent #387 image success do not establish it.

## Completed checks on the composed source

- Node 22.23.3 full unit suite: 615 files, 10,760 tests passed (324.22s).
- Real PostgreSQL 18.6: all reports-*.test.ts and purchase-schema-readiness.test.ts,
  8 files / 84 tests passed. Fresh synthetic container removed after completion.
- TypeScript noEmit: passed. Fixture ESLint and git diff --check: passed.
- Focused monthly witness plus sign/owner/navigation/financial-lifetime checks:
  97 tests passed before the full Node 22 suite (all also covered by that suite).
- Docker-filtered Node 22 Next production build: passed; preflight build/help:
  passed; runtime braces absence: 7,563 files and 343 traces verified.
- No local Chromium or hosted HTTP acceptance result is claimed.

The additional monthly-fixture composition commit is
`e7eeb0d591d602f52cbdbb15a9e33ae1e4c6448f`. The following documentation commit adds
only this record and logs; the reviewed source/guard semantics remain unchanged.
