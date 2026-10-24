# Metadata supplement validation

The parent-supplied recursive metadata-only SQL was executed unchanged apart from decoding transport `&gt;` / `&lt;`, on disposable PostgreSQL 18.6, inside REPEATABLE READ READ ONLY with the supplied search path and 5-second statement, 1-second lock, 5-second idle transaction and 15-second transaction limits. Rollback and disconnect completed before reporting the result.

- Empty synthetic database: SQLSTATE `00000`, 8 evidence entries.
- Initialized pre-Ortho fixture with exact 0051, nine runtime predecessor registrations and existing audit table: SQLSTATE `00000`, 334 evidence entries.
- Fixed diagnosis: `SYNTHETIC_METADATA_QUERY_ACCEPTED`.

No parser/type/runtime defect was reproduced, so there is no justified SQL correction. This does not diagnose the root's generic live `CATALOG_REFUSED`: target-specific timeout, permissions, catalog state, and wrapper/cleanup failure remain unverified. Do not infer that a live retry is authorized or necessary from this result. No live connection or production backup operation was made. No live metadata is stored here.
