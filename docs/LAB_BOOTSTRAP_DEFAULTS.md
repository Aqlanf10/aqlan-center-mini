# Fresh lab-catalog bootstrap integrity

## Evidence and scope

The previous runtime loop inserted only name, code, category, default days and
sort order. Existing table defaults therefore replaced canonical tooth scope,
shade requirements and description with `single_tooth`, `true` and `null`.
Actual fresh PostgreSQL 18.4 bootstrap showed 10 wrong scopes, seven wrong shade
flags and 19 missing descriptions against `DEFAULT_LAB_SERVICES`.

This affects money: the existing `createLabOrder` reads the persisted scope and
uses `labPricingQuantity` for automatic pricing. In disposable PostgreSQL, a
full-arch DNT_FULL order with a 1,000 YER rule and six selected teeth persisted a
6,000 YER order/payable. General-service MOD_STD has the same incorrect multiplier.
Per-tooth crown/bridge pricing must retain the six-unit calculation.

Read-only Production catalog inspection separately confirmed DNT_FULL was stored
as single-tooth. This is not proof that any historical order was overcharged.
The fresh-only repair below does not change that existing Production catalog.

## Narrow repair

`seedDefaultLabServices` inserts all eight canonical fields in one SQL statement,
only when the entire catalog is empty, and retains `ON CONFLICT (code) DO NOTHING`.
Any rejected row aborts the whole statement; startup cannot leave a two-row partial
catalog that would suppress later initialization. A lab-local catch logs failure
and permits independent expense/appointment defaults to continue.

It deliberately:

- Keeps `SKIP_SEED` and empty-table-only startup behavior
- Preserves nonempty, partially populated, edited, inactive and custom catalogs
- Does not refill deleted codes while another catalog row exists
- Keeps existing empty-catalog reseeding behavior, without a new marker
- Leaves explicit owner reset, price rules, order pricing, payable writing and
  historical financial amounts unchanged
- Does not call `ensureSchema` or the explicit owner reset from the helper

Existing metadata cannot safely be classified as accidental or intentional from
its current value alone. Any existing-catalog correction is a separate,
owner-preserving task. No migration, bulk existing-row correction, credential or
backup changes are included.

## Regression coverage

`__tests__/postgres/lab-services-seed.test.ts` exercises actual bootstrap and actual
order/payable writers on newly generated, loopback-only disposable PostgreSQL 18
databases. It covers every default field, full-arch/general quantity one,
per-tooth/bridge quantity six, SKIP_SEED, failure atomicity and later defaults,
retry, repeated cold starts, existing partial/custom catalogs, owner edits,
deactivation/deletion, empty-catalog reseeding and independent concurrent seeders.

All 12 cases pass with the fix. Restoring the exact prior `lib/db.ts` makes four
cases fail: metadata, DNT_FULL pricing, MOD_STD pricing and partial failure. The
existing pure lab and transaction unit suites remain part of focused validation;
full mandatory CI and post-merge Production verification remain release gates.

The canonical roadmap matrix also records the separately authorized successful
Production metadata-only preflight. Its sanitized report is evidence of registry
state, not an adoption or schema-equivalence assessment.
