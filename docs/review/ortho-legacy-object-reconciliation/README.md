# Explicit Ortho reconciliation and login diagnostics

This continuation starts at frozen candidate `c998b435306f8295a217e49f20080293c479c359`. The reproduction and design were imported from reviewed PR #454 head `1014a268afd0b477554c97f974b8961846cf69b8`; later changes to that PR are not incorporated. No changes to #451, published migrations, runtime/CLI guards, or health initialization.

## Result and boundaries

An unregistered 0051/0052 object still blocks startup and login. Login now emits one sanitized diagnostic, while preserving the existing JSON status/body and HTML redirect. The actual failure stage is `shared_limit`, before password verification; the earlier design incorrectly described the legacy limiter as the first failing call.

The separate operator tool defaults to a read-only transaction and read-only connection. It reports catalog observations without registering anything. `--apply-synthetic` enables an explicitly guarded, **synthetic-only prototype**. This is not authorization or a runbook for Staging/Production. No live connections, writes, release, deployment, or merge were performed.

A successful synthetic reconciliation records **catalog equivalence**, not historical execution of the migration SQL. Existing rows and sequence values are not updated. Normal startup can then register an absent companion migration and 0067 through its unchanged code path.

## Separate empty-0051 path

`npm run db:ortho:empty51` is a distinct report-default entrypoint for the reviewed empty-0051 remedy. It requires an explicit Staging endpoint/identity allowlist, verified TLS, independently reviewed source-compatible owner/ACL/locale reference, and a bounded maintenance/retention attestation. Only `--apply-empty-0051` enables writes. Ordinary relation locks, exact nine-version predecessors, full 0052 absence, absent 0067 registry/index, global emptiness and unchanged sequence checks protect its narrow scope. It atomically inserts a truthful format-1 event in the **existing** `audit_log` and the exact 0051 registry row. It creates no ledger and changes no immutable migration or startup guard.

See [STAGING-DESIGN.md](STAGING-DESIGN.md) for configuration, least-privilege requirements and maintenance limitations. The checked-in reference is synthetic, not a live witness. Implementation/testing does not establish live eligibility or authorize execution. Logging alone does not repair login; normal 0052/0067 initialization and root/owner Staging acceptance remain required after any separately approved reconciliation.

## Diagnostics

`lib/login-diagnostics.ts` emits JSON with fixed event `staff_login_failed`, a stage from the route's closed enum, and either `unclassified` or one of three Ortho categories with exactly `0051` or `0052`. It never emits an exception, message, detail, stack, cause, SQLSTATE, SQL, username, URL, request field, or arbitrary version. Error-message accessors are not evaluated by the diagnostic helper. Logger failures cannot replace the established response.

## Independent reference and catalog coverage

`npm run db:ortho:reference` requires the existing guarded `TEST_DATABASE_URL` for `aqlan_p1_test`. It checks the frozen migration sources, creates a new random database from `template0`, initializes the pinned candidate there, captures catalogs, and drops only the database whose captured OID and owner still match. **It never runs migration SQL in a target scratch schema.**

`schema/ortho-reconciliation-reference.pg18.json` is synthetic PG18 evidence, not a live catalog or row dump. The manifest pins source/checksums, the runtime registration set, the registry table catalog, and Ortho catalogs. Comparison preserves raw function text, including whitespace inside literals. It covers:

- relations, columns/defaults, constraints, indexes and their state;
- user and relevant internal FK triggers, routines and overloads;
- sequence properties and ownership, composite/array types;
- owners/ACLs, column privileges, collations/database locale, schema security;
- incoming/outgoing catalog dependencies, rules, policies, security labels.

Only PostgreSQL-generated internal trigger names and TOAST identities have physical identifiers normalized. Mutable sequence values and physical table statistics are excluded from shape comparison; sequence position is separately validated before applying. Unknown or partial shapes fail closed. Different roles, locale, PostgreSQL catalog semantics or source revisions can require a newly reviewed reference; do not normalize away such differences to make the tool pass.

The registry itself must match its reference catalog and the pinned runtime registration set (0067 may be absent). The true pre-Ortho fixture has nine prior registrations: 0056, 0057, 0058, 0063, 0064, 0065, 0066, 0068, 0069. It is created from `template0` by stopping initialization at the Ortho boundary, **before** 0051/0052/0067, rather than deleting these entries from a fully initialized database. The older #454 fixture remains separately covered.

## Operator interface (disposable local fixtures only)

```text
ORTHO_RECONCILE_URL=<owned disposable fixture URL> npm run db:ortho:reconcile
ORTHO_RECONCILE_URL=<owned disposable fixture URL> npm run db:ortho:reconcile -- --apply-synthetic --expected-oid=<captured OID> --capability=<fixture token>
```

There is no `DATABASE_URL` fallback and no live-target mode. The CLI permits numeric loopback hosts and generated `aqlan_ortho_legacy_<32 hex>_<suffix>` database names only, using the repository's verification-target policy. Applying additionally requires exact database name/OID, database ownership, a superuser on the disposable server, and a matching random capability in `ortho_synthetic_reconciliation_target`, which only the test harness provisions. Arguments and exceptions are not printed.

The write transaction:

1. Acquires the normal migration advisory lock and checks the explicit target identity/capability.
2. Locks relevant PostgreSQL catalogs, registry/marker tables, and existing Ortho/parent tables. After exact shape verification it reasserts the already matching sequence `OWNED BY` dependency to acquire PostgreSQL’s sequence DDL lock, blocking independent `nextval`/`setval`; it never restarts or changes sequence values/parameters. Rechecks target identity after locking. Refuses event triggers and unexpected registry/catalog state.
3. Checks current catalog equality, all pinned CHECK/NOT NULL/unique/FK constraints, final-state ownership and lineage rules, schema-2 assessment payload rules, and sequence positions. SQL expressions come from the checked-in reference; no target-supplied SQL is executed as a validation expression.
4. Creates a separate reconciliation ledger, then revalidates catalogs under the locks. Atomically inserts ledger evidence and the exact registry row required by unchanged startup/CLI guards. No new migration number is allocated.
5. Records `evidence_kind='catalog_equivalence'`, `historical_execution_verified=false`, source commit, checksum, catalog digest, operator and reconciliation time. Registry `applied_at` is the reconciliation time; it is **not** a claim about historical execution. `adopted=false` preserves the existing registry contract and must be read together with this explicit ledger.

The prototype deliberately refuses an existing reconciliation ledger instead of silently repeating or extending a previous operation. Concurrent requests serialize; only one records the pair. A failure before COMMIT attempts rollback. A failed COMMIT acknowledgement reports `uncertain_commit`, never success or an asserted rollback, and never retries automatically. Check registry **and** ledger on the same guarded synthetic target before deciding what happened.

## Bounded execution and completed output

The operator connection has a 5-second connect deadline and a 65-second client query deadline. Server limits are 60 seconds per statement, 30 seconds for locks, 10 seconds idle in a transaction, and 120 seconds per transaction. A referenced 180-second process watchdog bounds stalled networking or cleanup as well. Expiry reports a fixed deadline/unknown-outcome event and terminates; it never asserts that a COMMIT was rolled back.

A report is returned to stdout only after its read-only transaction rolls back and the dedicated connection closes successfully. Apply output likewise waits for connection cleanup after COMMIT. Cleanup failure after confirmed commit explicitly reports `outcome=committed`; a failed report cleanup reports `read_only`; ambiguous apply cleanup reports `unknown`. No exception content is emitted.

The catalog collector covers the guard's full constraint/index collision-name list, including names occupied by standalone objects when the revision table is absent. Unit parity and real PostgreSQL negative tests enforce this without editing the startup guard.

## Design blockers before any live proposal

The catalog lock strategy requires a superuser and affects shared server catalogs, so it is intentionally unsuitable for an unattended live repair. A separately reviewed live plan must resolve locking/maintenance scope, role/ACL/locale equivalence, data validation against the actual legacy contract, and operator evidence retention. PostgreSQL catalog dependencies cannot prove the absence of external application references or dynamic SQL. Neither reference equality nor the private observation that captured 0051 definitions matched establishes provenance.

Root handles any future live application separately. Staging must be tested and accepted by root and the owner before any production release.

## Validation

The original #454 reproduction independently passed 5/5 on PostgreSQL 18.6 before modification; the existing registration suite independently passed 16/16. Current focused results and exact-head CI status are recorded in `VALIDATION.md`. These are distinct from full CI, build/image, HTTP-security, and live acceptance stages.

The separate [Staging design](STAGING-DESIGN.md) narrows any future proposal to empty, exact 0051 only and requires supported audit retention, compatible identity/ACL/locale evidence, and a verified maintenance window. [Advanced PR454 source review](PR454-ADVANCED-REVIEW.md) records why those newer changes were not merged.
