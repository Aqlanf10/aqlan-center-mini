# Patient numbering: synthetic PostgreSQL boundary pilot

This code cannot be installed by the application. It is not a migration or release candidate. The pilot SQL deliberately refuses database names outside the isolated review harness; production has no route, toggle, DB role or new statement installed by this work. The runtime's four existing writers and numbering remain unchanged. Do not bypass the fixture-only restriction or apply this SQL to any shared clinic environment.

## What is executable and proven here

- A single existing sequence supplies ordinals. LEGACY preserves the exact current P-number insert expression and never accepts the new writer. Under explicit operator transition the same sequence supplies only MANAGED issuance, atomically with the prefix and revision. In MANAGED a protected trigger replaces a NULL input with the allocated non-null identifier before persistence. Existing identifiers are never rewritten. The SQL operator is a synthetic control-plane role, **not** a clinic owner or product enrollment.
- Cutover waits for active table writers, denies an enrolled runtime with a bypass grant, revokes runtime sequence access, and blocks explicit legacy numbers at the table even if an old binary uses a direct insert. This proof assumes ownership and grants are provisioned exactly as tested: clinic runtime has none of the owner's or operator's powers. A warm runtime that owns the destination table, sequence or an unconstrained privileged function is an unsolved release blocker, not a compatible case.
- Restart uses transactional ALTER only when increasing the next number. Rollback of a policy change does not renumber anything or advance the counter; rollback of an insertion burns its ordinal as before. Changing back to a previous prefix does not reset the ordinal. Existing case-folded strings are respected; width never truncates. This pilot conservatively never lowers the 7000 minimum or global high-water mark; it does not authorize restarting from 1500 under a new prefix.
- Recovery-hold stops both writer forms. Inspection reports the real `last_value` and `is_called`, and a clone to a different database identity (cluster system identifier plus database OID) cannot be reactivated by copied policy. A storage-level clone retaining both identities is outside this guarantee and requires external fencing. The inspection view is not an archival barrier while issuance is active: capture the protected checkpoint only under a proven hold or maintenance fence. There is no application resume/re-enrollment or auto-restore path. The optional fixture-only companion below exercises explicit synthetic recovery.

## Before any mounted staging feature

1. Prove a real authenticated, active owner bound to immutable trusted server identity, and revalidate in the same transaction. No ordinary-admin policy API, parallel owner registry, environment-ID guess, privileged PG user impersonation, unsigned fixture callback or canonical fallback.
2. Review the actual provisioned physical roles and connection topology, including legacy startup, connection pools, restricted bootstrap, CSV locking, workers, potential SECURITY DEFINER paths and operators. This pilot observes only its isolated well-defined role graph.
3. Implement and verify the compatible writer and mounted settings separately. Exercise POST /api/patients, PATCH /api/visits/[id] open_file, POST /api/patients/import commit, and PATCH /api/booking-requests/[id] confirm using the real app with two processes and roles. Current 17 baseline witnesses validate legacy run paths only; they do not prove managed UI behavior.
4. Preserve data protection. Current lib/ai-tools/privacy.ts recognizes P-style numbers. Do not switch to an arbitrary prefix until existing patient-identifier redaction is proven (including old and historical prefixes and Unicode/case). This review does not add or change AI features.
5. Reconcile archive scope with the current application backup, preserve independent sequence and pending/consumed state, and demonstrate positive restore+resume through authorized, fenced recovery, not reconstruction from remaining rows or a copied policy. Clone fail-closed evidence is not a positive recovery drill. Reverting an app binary while MANAGED must keep the hold or a compatible fenced writer; there is no safe unrestricted P fallback.
6. No invented 0080/0090 migration lineage, applied-file changes or manual ledger adoption. Establish a new reviewed integration and a verified exact rollout record only after all gates pass.

Tests are development-only in `__tests__/postgres/patient-numbering-db-fence-review.test.ts`; use an exclusive loopback PostgreSQL 18 test instance with disposable DB/role administration. The test harness reserves four known synthetic NOLOGIN roles and refuses to reuse preexisting roles. It creates no credentials and drops only objects it created.

## Synthetic recovery companion (still unmounted)

`patient-numbering-recovery.pg18.sql` permits only the role that already owns the isolated fixture to capture a checkpoint after a committed hold. The checkpoint binds the held native database identity, policy revision/prefix, exact sequence value and pending flag, and a digest of the ordered synthetic ID → number mapping. A copied checkpoint never authorizes recovery by itself. The standalone proof provides the independently chosen target identity and expected witness (no DB or clinic credentials), rejects mismatch/old-writer roles, and performs one transaction that changes only the target binding and revision. No number assignment or counter reset occurs during logical recovery. Keep the original source held.

Run the separate local proof with the PostgreSQL 18 tools directory supplied as `PG_BIN`:
```sh
PG_BIN=/path/to/postgresql-18/bin python3 scripts/review/prove-numbering-restart-archive.py
```

It accepts no database URL, creates its own loopback cluster and private synthetic archive, verifies the real process stop/start and `pg_dump` + `pg_restore`, and cleans up its own data. Do not generalize this result to the Clinic app backup format, production recovery authority, hard power loss, or a physical duplicate that retains both cluster and database identity. Immutable and independently authenticated recovery approval/provenance still must be provided before any real integration.
