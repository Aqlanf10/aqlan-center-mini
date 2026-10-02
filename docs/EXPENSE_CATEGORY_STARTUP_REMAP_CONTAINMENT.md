# Preserve configured expense accounts across bootstrap

Date: 2026-10-02. Separate follow-up to runtime category containment commit
`6e2689e`; this closes only the two direct account-rewrite statements documented
in that commit's startup-seam section.

## Change

Remove exactly these unconditional `ensureSchema` updates:

- `facility_maintenance`: 5601 → 5504
- `marketing`: 5901 → 5902

A configured account can represent the intentional classification of recorded
vouchers. Repeating schema bootstrap must not replace it and thereby change the
derived historical journal. The normal guarded category writer remains available
for genuinely unused configuration.

No replacement update, historical backfill, schema migration or new ledger is
introduced. NULL-posting normalization, column defaults, the empty-table seed and
its current default account values are unchanged. Existing values are retained,
not automatically corrected. This is prospective protection for saved settings;
it does not repair or infer Production history.

## Real PostgreSQL regression proof

The focused suite adds three assertions to the preceding 45-case proof:

1. On a new empty synthetic database, fresh bootstrap seeds
   `facility_maintenance=5504` and `marketing=5902`, both with posting enabled.
2. Configure unused `facility_maintenance=5601`, record a key-referenced voucher,
   close its shift, then call `schemaReadyReset()` and `ensureSchema()` twice.
   All category rows, the entire derived journal, voucher and closed shift must
   remain exactly unchanged.
3. Repeat for `marketing=5901`, with a legacy-name-referenced voucher.

Before removing the statements: **46 passed, 2 failed**. Both intended cold-start
regressions failed because bootstrap changed category accounts and historical
journal lines. Fresh defaults and the earlier 45 runtime cases passed.

After removing only the two statements: **48/48 passed** on PostgreSQL 18.4,
Node 22.23.3, including both repeat-bootstrap checks. Focused test lint, Bash
syntax and diff whitespace checks passed. Full typecheck/build and remote CI are
separate release gates and were not run for this local proof.

Reproduction uses the unchanged guarded fresh-cluster runner:

```sh
NODE_BIN=/path/to/node22 PG18_BIN_DIR=/path/to/postgresql18/bin \
  bash scripts/audits/expense-category-history-proof.sh
```

Both synthetic before/after clusters were stopped and retained. Local evidence:
`category-startup-before-fix.log`, `category-startup-after-fix.log`, and each
runner-created cluster's `stop.log` outside the source checkout.

## Boundary

This does not establish complete bootstrap/schema ownership. In particular, the
existing NULL normalization and seed-on-empty behavior remain separate seams;
no guarantee is made about introducing seeded aliases into a legacy database
whose category table was emptied while raw expense strings remain. Party and
laboratory mapping writers and other previously documented accounting gaps are
also unchanged. No Production database or credentials were used in this work.
