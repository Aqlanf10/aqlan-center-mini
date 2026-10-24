# Proposed minimal Staging repair — design only, not executed

**Staging login is not fixed by diagnostics or by the synthetic tool.** The known blocker is an unregistered 0051 object causing `ORTHO_UNREGISTERED_OBJECT_COLLISION` inside initialization before password verification. Captured definitions reportedly match pinned source, but that observation does not establish full catalog equivalence, ownership/ACL/locale compatibility, an empty table, or provenance.

No live access, credential/privilege change, repair, application restart, migration, or deployment is authorized or performed by this document. The existing CLI remains numeric-loopback/synthetic-only. Do not relax its Railway or target gates.

## Narrow eligibility

A future separately reviewed operator action may reconcile **0051 only**, and only when:

- `public.ortho_strategy_revisions` is present, fully exact and **empty at action time**; any row, partial object, extra dependency or differing property refuses the operation.
- 0051 has no registry row. The prior runtime registrations are exactly the approved candidate set, with full name/checksum/adopted checks.
- The complete 0052 collision scope is absent and 0052 is unregistered. This proposal never reconciles 0052. Its normal migration must execute later.
- 0067 is in the explicitly approved predecessor state (expected absent for the minimal path); initialization will apply it normally. Unexpected 0052/0067/other registration states stop this minimal procedure.
- The actual PG18 identity, source commit, owner/ACL policy, locale and full contract evidence are independently approved. The synthetic `ci` / `en_US.utf8` reference is **not** live-equivalence evidence.
- A bounded maintenance window stops application instances, workers, automatic restarts, migration jobs, restore/reset jobs and other writers. All DDL-capable operators agree to no DDL for the window, and there are no independent sequence callers. The migration advisory lock alone does not enforce this: `ensureSchema` has DDL before the Ortho lock, and function replacement is not prevented by table locks.

If that operational quiescence cannot be established, this least-privilege design is blocked. Do not substitute a fingerprint check for exclusion of concurrent DDL, grant superuser, take global catalog locks, or silently widen the scope.

## Compatible reference and explicit security witness

Generate the reference in a wholly separate synthetic database, using immutable migration SQL and a predecessor compatible with the approved PG18 version, encoding, database locale, collation provider/version and relevant extensions. Never execute migration SQL in a target scratch schema.

The reviewed witness must list actual expected owners, ACLs/grantors/grantees, schema ownership, relevant role memberships and effective privileges. OID-to-identity conversion may resolve physical IDs to their explicit names; it must not remove owner/ACL evidence or turn arbitrary roles into an undifferentiated “owner” token. Any reference-role mapping must be explicit, object-scoped and reviewed in advance. The existing synthetic manifest must remain unchanged merely to make an unknown live catalog pass.

Collect the complete guard collision scope plus columns/defaults, all constraints/index states, user and relevant internal triggers, exact routines, sequences/ownership, types, collations, security labels, policies/rules, and incoming/outgoing dependencies. Also verify the existing registry and audit contracts, defaults and triggers. Keep actual live evidence private under root's approved process; do not put database URLs, credentials, row contents or live metadata dumps in this repository.

## Least-privilege atomic alternative

Use a dedicated operator connection under an **existing authorized role**, with connection/query/statement/lock/idle-transaction/transaction/process deadlines. The following is an algorithm for review, not executable live SQL:

1. Verify the explicitly approved Staging server/database identity and current/session role before a write transaction. Verify the maintenance/no-DDL/no-sequence-caller witness and candidate/reference digests. Refuse Production, ambiguity, privilege gaps or an expired approval window.
2. Begin `READ COMMITTED`; acquire the existing migration advisory transaction lock. Acquire ordinary relation locks in a fixed order: `SHARE ROW EXCLUSIVE` on `schema_migrations`, `SHARE` on the exact 0051 table and on the audit table if its reviewed insertion/retention contract requires it. Do not lock PostgreSQL system catalogs. No parent-row locks are needed for the empty-table path; parent catalog definitions remain protected by the verified no-DDL window.
3. Re-read identity, the full reference/security witness, every applicable registry row, exact 0051 shape and `NOT EXISTS` row condition **after locks**. Check 0052 is absent across the whole guard scope and 0067 remains in the approved state. Read the 0051 sequence position/properties and reject exhaustion/invalid state without resetting it. Do not call `nextval`, `setval` or `ALTER SEQUENCE` on the clinical sequence in this minimal path; the maintenance window must exclude independent sequence callers.
4. Insert one fixed-format provenance event through the **existing supported transactional audit mechanism**, then the exact 0051 registry row, on this same connection and transaction. Do not call the ordinary application `recordAudit` helper if it starts initialization or uses another connection. Verify the supported audit contract first; use a narrow parameterized insert with no unreviewed helper, trigger or exception logging.
5. The event must say `evidence_kind=catalog_equivalence`, `historical_execution_verified=false`, with 0051 name/checksum, source commit, reference/catalog/security-witness digests, empty-row count, original sequence state, target identity witness, action ID, operator/session role, approval reference and transaction timestamp. No migration-execution claim. The registry timestamp records reconciliation time. Never synthesize a historical execution time or set `adopted=true`.
6. Recheck full shape, empty state, sequence state, 0052/0067 prerequisites and witness expiry under the same locks/window immediately before COMMIT. Both writes commit together or neither does. If COMMIT acknowledgement is lost, report an unknown outcome and make **no automatic retry**. Root must check the exact registry row and matching action-ID audit evidence using a new authorized connection.
7. After confirmed completion and release of the repair connection, root resumes the approved candidate under the maintenance plan and allows normal initialization to run 0052/0067. Verify actual initialization and login, not health alone. Root and owner independently test/accept Staging. No Production release follows automatically.

Ordinary locks protect table data but do not exclude unrelated function/ACL/namespace DDL. PostgreSQL also warns that snapshots taken before acquiring locks can be stale; the action-time checks above therefore use `READ COMMITTED` after lock acquisition. See [PG18 LOCK](https://www.postgresql.org/docs/18/sql-lock.html).

## Required existing permissions (verify; do not grant as part of this work)

| Purpose | Minimum relevant permission/precondition |
|---|---|
| Connect/read evidence | CONNECT to the explicitly selected database, USAGE on public, readable catalog definitions, SELECT on 0051, registry, audit evidence and the 0051 sequence; visibility must not be filtered by RLS. Refuse an unverified RLS visibility path. |
| Ordinary relation locks | Object ownership or PG18 MAINTAIN on each explicitly locked table is sufficient; UPDATE/DELETE/TRUNCATE also authorize these lock modes but must not be newly granted as a shortcut. SELECT alone only permits ACCESS SHARE, which does not block inserts. |
| Registry/audit insert | INSERT on the required columns of schema_migrations and audit_log, plus USAGE on audit_log's existing sequence if required by its default. No clinical sequence write privilege is needed in the empty-only design. |
| DDL exclusion | Operational control and explicit cooperation of every role/operator that can change the relevant objects; this is not conferred by the advisory lock. No superuser, system-catalog write grant, new SECURITY DEFINER function, ownership transfer or credential rotation. |
| Evidence retention | A supported audit backup/restore/reset/retention path, verified with synthetic round-trip tests and reviewed operator retention procedures before live approval. |

PG18 documents MAINTAIN and the other table-lock permissions in [LOCK](https://www.postgresql.org/docs/18/sql-lock.html). An alternate sequence-locking design would require sequence ownership for `ALTER SEQUENCE`, so it is deliberately outside this minimal path; see [ALTER SEQUENCE](https://www.postgresql.org/docs/18/sql-altersequence.html).

## Provenance lifecycle is a blocking review item

Do **not** create `ortho_reconciliation_records` live. That prototype table has no numbered schema ownership, fresh-bootstrap contract or supported restore/reset lifecycle. A data-only backup might contain its rows while a freshly initialized restore target lacks its schema.

The existing `audit_log` is a candidate supported mechanism, not yet a completed retention proof:

- It is in the current schema contract; runtime supplies append-only UPDATE/DELETE triggers (`lib/db.ts`).
- `RESET_KEEP_TABLES` explicitly preserves both `audit_log` and `schema_migrations` (`lib/clinic-reset.ts`).
- Backups are data-only and enumerate schema tables (`lib/backup.ts`), while restore deliberately filters source `schema_migrations` inserts (`lib/restore/sql.mjs`). Therefore a restored provenance event must remain explicitly tied to its **original target/action**, not be treated as proof of the destination's registry state.

Before approval, demonstrate with disposable synthetic data that the chosen event survives supported backup/restore and reset, retains all required fields, and is not removed by retention/export policy. Verify the destination contract and audit privileges/triggers at action time. If existing audit cannot satisfy this, stop: a new ledger requires explicit schema-contract ownership and backup/restore/reset integration in a separately reviewed change. No permanent untracked schema is an acceptable shortcut.

## Evidence still required from root's separately authorized process

Actual empty-state proof; full 0051 catalog/security/locale/dependency witness; absence of all 0052 collision objects; exact predecessor registry; precise Staging identity; usable existing permissions; maintenance/no-DDL/no-sequence-caller control; supported audit retention/round-trip proof; a current backup/recovery plan; independent approval of the final action and digests. None is inferred from health readiness, a matching captured table definition, or passing synthetic tests.
