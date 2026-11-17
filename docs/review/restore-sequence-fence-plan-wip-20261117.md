# Restore sequence atomicity and target fencing — evidence and unresolved design

Status: investigation, **not a product fix or release approval**. All examples
and observed targets were synthetic. The independent CI jobs below do not
establish the state of any production or patient database.

## Observed facts and scope

- [CI 44099616653](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/44099616653)
  at `603b4756584e7570dfacd0f62e76699ccd3702c1` reached the staged replay on
  owned synthetic PostgreSQL targets. Four nonempty-target cases showed the
  serial next candidate regress: valid and late-failing writer archives with
  `is_called` false and true. Both failure cases reached the exact synthetic
  duplicate primary-key error before the sequence-state assertion failed. A
  fifth case showed regression after a concurrent allocation. The nonempty
  rejection control passed. The job and CI were not green.
- [CI 44108200039](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/44108200039)
  at `9fca96b59b279e03d3b6818e835709b0ff04d676` separately observed, after
  synthetic late replay failure, the target registry's 0080 row matching its
  local source and the named policy table present. It also checked the old
  registry fields, selected patient rows, stage marker, two archive hashes,
  and target OID/owner. It did not check every target table or the source
  registry. The standalone job still failed on the five sequence cases.
- [CI 44113745713](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/44113745713)
  at `df3531956cc93ce7b0735d18f08f29e93702dc47` ran the separate reserved-ID
  witness successfully (2/2): in both `is_called` states, an independent SQL
  actor reserved an ID, staged legacy replay was accepted on the owned
  nonempty target, and that actor's later insert hit `23505` on `patients_pkey`.
  This deliberately noncooperating actor is not proof that the usual
  `createPatient` journey separates allocation from its INSERT. The witness
  compared the restored source row before the actor attempted insertion, and
  then rechecked the original target row, source, stage, archive and target
  identity; it did not recompare the restored row after the attempt or every
  target table on the accepted branch. Its standalone job failed overall on
  the five inherited sequence cases; no complete CI success is claimed.
- [CI 44107894203](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/44107894203)
  at `09a63c25a64da905b0f38c0d9e11223c19f7b8fa` passed its standalone job:
  12/12 tests across three files, including eight isolated PostgreSQL 18
  mechanics cases. On that service, plain `setval` survived rollback; an
  `ALTER SEQUENCE ... INCREMENT BY` of the existing increment followed by
  `setval`/`nextval` preserved state on rollback for both `is_called` values;
  commit and next-candidate checks passed for both; a concurrent nextval
  waited until commit/rollback; and one prior-cache experiment that changed
  `CACHE 10` to `CACHE 1` along with the same increment did not observe an old
  cached value on one subsequent allocation. This does not attribute cache
  behavior to the increment rewrite alone. This is not application integration, a complete
  cache/session proof, or a successful full CI.

On the reviewed application revision, `stagedRestore` runs
`migrate(...apply:true)` before the transaction containing `dataSql` replay.
Individual pending migrations commit separately. This matters for the direct
legacy, noncanonical `allowNonEmptyTarget` route; canonical source restores
require an empty target. The admin drill is distinct: after source precheck it
resets its designated target before staged restore and passes the nonempty
override as false. No claim is made that admin keeps its pre-reset target.
The current `targetTableCount` reads `information_schema.tables` in `public`;
visibility and scope limitations mean that count alone cannot establish that
an entire target database is empty or isolated. Failed replay after migration
on a fresh target may also leave a partial schema, while document staging is
performed after database commit and may fail independently; neither is limited
to the nonempty-target scenario.
`scripts/restore.mjs` separately executes `dataSql` with `setval`; on this
revision its target guard restricts it to local synthetic fixture targets, so
do not describe it as an observed production entry point. It still needs
coverage and explicit safe handling when the executor changes.

The two sequence contracts differ. `patients.id` is an internal serial ID;
its observed next-candidate regression can reissue an ID. The patient-file
allocator instead combines `patient_number_seq`, the numbering policy and
retired/current aliases. Migration 0080 explicitly permits gaps from
allocation or `setval` after rollback to avoid identifier reuse. Do not
therefore impose exact `patient_number_seq` value/`is_called` equality on
every failed operation. Preserve its no-regression/no-reuse guarantees, policy,
retired aliases and the twelve historical source/target cases. The strict
patient-number state check in the `603b` legacy witness is limited to an
isolated archive that neither carries that sequence statement nor runs a
concurrent patient-number allocation; it is not a general gapless requirement.

## Candidate work, not an approved contract

1. Keep archive bytes and historical fingerprints untouched. At preflight,
   recognize only exact supported writer statements using the existing parser
   boundaries and typed metadata. Preserve statement order and quoted literal
   handling; never evaluate an arbitrary archive expression or silently accept
   an unknown historical migration. All source-determinable refusals in the
   admin drill must happen before removal of prior stage files or target reset.
2. Define a genuinely read-only target preflight before applying migrations to
   an existing target. `migrationStatus` is not universally read-only: if an
   unregistered baseline is probed, its helper creates a schema and runs DDL
   in a rolled-back transaction. A SELECT-only catalog/registry inspection can
   identify known pending or inconsistent states; handling an unregistered
   legacy baseline or refusing nonempty targets requires an explicit reviewed
   contract, not an inferred policy. Pending migrations currently commit before
   replay: moving them into one transaction requires refactoring nested
   `BEGIN`/`COMMIT`, locks and 0079 adoption, or a different reviewed isolation
   design. Sequence protection alone does not undo them.
3. Determine the complete target sequence set from trusted target catalog
   dependencies and the effective search path, not archive table names alone.
   `pg_get_serial_sequence('table','id')` and the patient number sequence are
   unqualified in historical SQL; dependencies can resolve outside `public`.
   Defaults, triggers or finalizers may consume sequences absent from older
   source archives. A secure, compatible search-path contract and treatment of
   unreviewed functions/triggers must be established; reject a case whose scope
   cannot be proved, without treating unknown objects as safe.
4. Investigate taking the required sequence locks and transactional rewrite in
   deterministic order **before** any replay operation that can use them.
   Compute from verified catalog identifiers, bounded `bigint` values,
   increment, bounds, cycle and the actual `last_value`/`is_called` state; preserve the
   existing patient-number policy and twelve documented source/target cases.
   Sequence ownership for `ALTER` is a stricter requirement than update
   permission for `setval`; test and disclose that compatibility limit. GREATEST
   read before acquiring a lock is not a concurrency solution. The raw CLI and
   staged path must share or explicitly reject unsupported behavior.
5. A sequence lock does not by itself prove the target is quiescent: another
   backend might have received an ID before the lock but not inserted it yet,
   so a restored explicit ID could collide later. Older cached allocations and
   backend/session lifecycle require further analysis despite the one observed
   PG18 cache experiment. A `pg_stat_activity` snapshot is subject to a new
   connection race; advisory locks protect only cooperating writers. Do not
   implement REVOKE CONNECT, backend termination, or other target policy
   changes without an authorized reviewed isolation contract. If isolation or
   privilege cannot be established, fail safely with a bounded reason and
   preserve the evidence, rather than lower a counter.
6. Test the candidate with owned synthetic fresh and historical targets,
   including 0079/0090 pre-reset refusal, successful/failed replay at each
   sequence, both `is_called` states, custom schema and trigger sequences,
   bounded/exhausted/cycling sequences, insufficient ownership, concurrency
   before and after lock, cache and backend lifecycle, migration failure and
   crash boundaries, and the raw CLI. Verify registry timestamps/checksums,
   application rows and documents, stage bytes, sequence state and identity.
   Keep the currently red regression tests and report exact head and scope.

Official references: [PostgreSQL sequence functions](https://www.postgresql.org/docs/current/functions-sequence.html),
[ALTER SEQUENCE](https://www.postgresql.org/docs/current/sql-altersequence.html),
and [PostgreSQL 18 sequence implementation](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/commands/sequence.c).
The source implementation and one synthetic service result are evidence for
further testing, not a blanket guarantee for every supported PostgreSQL version.
