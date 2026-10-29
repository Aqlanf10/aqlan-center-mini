# Target-side restore protocol for canonical inventory history — PROPOSAL for review

Status: **proposal, not implemented. Revision 2 (Dot review 6479317375 items 1, 2 and 4).** Written for Dot's review (6458434508: "restore must not import the source realm or execution history; it needs a reviewed target-side protocol"; 6475545205 item 5: "review the target-side recovery protocol before M3a implementation").

Read it with:
- [CANONICAL-RECOVERY-REQUIREMENTS-20261027.md](CANONICAL-RECOVERY-REQUIREMENTS-20261027.md), the requirements this proposal answers;
- `docs/security/staff-cutover/OWNER_READINESS_AND_ISSUANCE.md` §2 and §7, the owner trust root and the deferred preparation and seal service.

No live database, backup, credential or Production action is involved.

## 1. Facts on the current head

1. **Backup copies every base table.** `backupSnapshotSqlLines` (`lib/db.ts`) emits every base table in `public`. In a canonical database that includes:
   - the identity substrate (`staff_authority_control`, `staff_identity_*`);
   - the runtime readiness tables;
   - the `users` columns that 0076 adds (`authorization_mode`, `authorization_epoch`) and `parties.clinical_authority_epoch`.
2. **Restore replays the data into a freshly migrated schema.** Restore (`lib/restore/staging.ts`, `scripts/restore.mjs`) runs data INSERTs into a schema built by `migrate` plus explicit proposals. That target has no identity substrate. A canonical backup therefore **cannot be restored today**: its INSERTs name tables and columns the target lacks. This is a real M4 gate, not an inventory defect.
3. **Finalisation only knows the retired parallel schema.** `finalizeRestoredStaffIdentityInTransaction` operates on the retired parallel schema (`staff_authority_identity`, `staff_execution_epochs`) and returns `null` when it is absent. It has no canonical behaviour.
4. **Supplier intents carry opaque identity columns (M3a, this head).** Their only foreign key used to point at the parallel `staff_execution_epochs`; that key is removed. `realm_id`, `subject_id` and `execution_epoch_id` (now the canonical identity generation) are opaque, immutable evidence. This is the "separately reviewed representation" the requirements ask for: source generation S can be imported into a target whose history has no S, without a dangling key and without rewriting S to T.
5. **The runtime enforces the triple, and nothing else lets a command run.**
   - Admission writes the current canonical `{realm, subject, generation}` proved in the same transaction.
   - Execution, replay and retirement require that exact realm and subject.
   - Pending work also requires the current generation.
   - A foreign realm or subject gets `supplier_saved_authority_mismatch`; so does an earlier generation for pending work. A forged envelope fails its digest, or the saved-admission lookup (`__tests__/postgres/inventory-supplier-operational.test.ts`).
6. **The legacy supplier path is retired.** The legacy-admin supplier adapter refuses with `supplier_canonical_identity_required`. It could not run anyway: its parallel schema is an authority footprint, so entry stays in maintenance.

## 2. Proposed protocol

### Backup (source side)

- **B1. Identity is not data.** The substrate and runtime tables are target-owned authority. Backup excludes them from the data section and records only a provenance line in the manifest: source realm, source generation, registry revision and a digest. That line is lineage evidence, never authority.
- **B2. Project away the identity columns.** `users` and `parties` are exported without the identity columns 0076 adds. Business columns (`id`, `username`, `role` label, `party_id`, `permissions` document) stay. The capability document is data. It is re-proved in the target only after the owner prepares the target (B3), and it grants nothing before that.
- **B3. Inventory and finance evidence goes in unchanged.** Command bindings, supplier intents, rejections, retirements, operations and invoice roots are business evidence. Their source realm, subject and generation values are kept exactly.

### Restore (target side, in the maintenance window decided by the owner)

- **R1. A target-owned durable hold comes before any replay (revised).** A marker-free target is NOT maintenance: `readStaffEntryMode` (`lib/legacy-staff-schema.mjs`) selects `legacy` for zero markers, and the login route then runs the legacy path. Absence of a canonical issuer therefore proves nothing. The protocol is:
  1. **Hold first.** Before any data is replayed, the restore tool creates `staff_restore_hold` in its own committed transaction. That is a single row: hold id, source manifest digest, created at, state `held`. If the hold cannot be committed, nothing is replayed.
  2. **The hold is an authority footprint.** It is added to the footprint relations in `lib/legacy-staff-schema.mjs`. Any database holding it selects the `canonical` entry, so the legacy login path never runs. With no ready identity, the canonical issuer answers `unavailable` (maintenance).
  3. **Every entry and writer refuses while held:**
     - password login: maintenance;
     - legacy cookies: revalidation goes through `findUserByUsername`, which calls `readLegacyStaffSchema`. That throws `LEGACY_STAFF_AUTHORITY_SCHEMA_HELD` on any footprint, so `requireSession` answers no session. Legacy writers take the same boundary (`lockLegacyStaffBoundary`). This holds today for every relation in the footprint list; the hold only has to be added to that list;
     - canonical cookies: no ready identity, so admission fails;
     - every canonical operation and owning reader: the proof needs `ready`;
     - direct application writes go through the same boundaries.
  4. **Durable.** The hold survives restarts, failed replays and partial or failed preparation, because it is a committed row, not process state.
  5. **Only a reviewed seal releases it.** The preparation/seal service (R3) deletes the hold in the same transaction that seals the target's `ready` state, with the seal evidence. Nothing else may delete or alter the hold row: a guard trigger refuses UPDATE, DELETE and TRUNCATE unless the seal path's transaction-local marker is set. No source authority is imported at any point (R2).
- **R2. No identity is adopted.** Nothing copies a source subject, realm or generation into target authority. A numeric `users.id` is never treated as continuity.
- **R3. The owner prepares the target.** The deferred preparation and seal service (tracked in `M1_ENTRY_SLICE_DESIGN.md` §6) runs only after replay. It creates a **target** realm and generation and binds every account to a fresh subject. This is the only route back to canonical entry.
- **R4. Restored history stays inert.** Once the target is ready:
  - **Committed source commands.** Their business effects (posted invoice, payable, stock) are present and visible through ordinary canonical reads. Their acknowledgements are **not** replayable: there is no subject continuity, and a terminal-outcome read needs the separately governed historical read binding, which is not built.
  - **Retired source commands and rejections:** inert evidence.
  - **Pending source intents:** never executable and never retirable through the normal path (realm/subject/generation mismatch). They keep their invoice "unresolved", so a new intent for the **same** invoice is durably rejected. Independent invoices proceed.
- **R5. Explicit owner-only recovery (revised; to implement after approval).** This releases a held source intent. It is **not** a delegable capability: it is a new owner-only runtime operation, `inventory.supplier-intent.recover`. It is added to `OWNER_ONLY_OPERATIONS` and checked with `canPerformOwnerOperation` (protected-owner binding) inside the admitted transaction. No UI flag or role label decides it, and a delegated user who holds `inventory.supplier-invoices.cancel` is refused. It:
  - accepts only a source intent whose realm or generation differs from the target's;
  - takes the exact original operation lock;
  - proves no committed result exists in the restored data;
  - records an append-only retirement for the original command key, with a bounded reason;
  - audits the **releasing** canonical actor separately from the stored source actor snapshot.

  It never executes the source command and never re-keys it. The original source evidence (command key, source realm/subject/generation, stored actor snapshot) stays unchanged. The recovering owner is recorded as a distinct actor.

## 3. Acceptance after approval (replaces the old same-realm restore suite)

### 3.0 Matrix (revision 2)

| # | Case | Positive or refusal | Proves |
|---|---|---|---|
| H1 | Hold created before replay; replay refused when the hold commit fails | refusal | R1.1 |
| H2 | Password login during and after replay, before the seal | refusal (maintenance) | R1.2–3 |
| H3 | Legacy cookie signed for the target, and a direct legacy writer, while held | refusal | R1.3 |
| H4 | A source canonical cookie, and a target cookie minted before the hold | refusal | R1.3, R2 |
| H5 | Server restart while held; failed or partial preparation | the hold persists | R1.4 |
| H6 | UPDATE, DELETE or TRUNCATE of the hold outside the seal path | refusal | R1.5 |
| H7 | Successful synthetic seal releases the hold; login and canonical reads work | **positive** | R1.5, R3 |
| P1 | Full round trip: business rows equal the source, number claims rebuilt exactly | **positive** | B3, §3.1–2 |
| P2 | Restored inventory and finance history visible through canonical reads after the seal | **positive** | R4 |
| O1 | Owner recovery releases a held source intent; the same invoice is admitted again exactly once | **positive** | R5 |
| O2 | A delegate with `inventory.supplier-invoices.cancel` attempts recovery | refusal | R5 owner-only |
| O3 | Owner revoked (ownership transferred) while the recovery waits on the operation lock | refusal | R5 |
| O4 | Duplicate request; lost response then retry | one retirement, same result | R5 |
| O5 | Two racing recoveries of one intent | exactly one succeeds | R5 |
| O6 | Recovery of an intent whose result is committed in the restored data | refusal | R5 |
| O7 | Audit insert fails during recovery | everything rolls back | R5 |

Positive restoration coverage is kept (H7, P1, P2, O1). It is never replaced by refusal-only tests. Preparation/seal itself stays deferred and live activation closed. H7 uses a synthetic seal fixture until the reviewed service exists.

Every case runs on an owned PostgreSQL 18 database:

1. **Full round trip.** Canonical source with posted, cancelled, retired, pending, refused and number-completed invoices → backup → restore into a marker-free target → the target stays in maintenance → synthetic preparation (fixture; the real service is deferred) → the assertions in R4.
2. **Rows survive exactly.** Business rows are equal to the source snapshot. Number claims are reconstructed exactly from immutable sources, as they are today.
3. **Excluded data stays out.**
   - No identity table rows are imported.
   - The source manifest provenance is present.
   - The users and parties identity columns come from the target, not the source.
4. **Restored history has no authority.**
   - A pending source intent refuses execution and normal retirement.
   - A new nonce for the same invoice is refused durably; an independent invoice proceeds.
   - After R5, the same invoice can be admitted again exactly once.
5. **Failure cases.**
   - Reset after restore refuses while inventory history exists (unchanged rule).
   - A restore failure, an audit failure or a refused owner recovery leaves the target in maintenance, with the evidence intact.

## 4. What stays red until this is reviewed

`__tests__/postgres/inventory-authority-restore.test.ts` still exercises the retired parallel schema: a same-realm epoch rotation and a signed `authority` session. It is red on purpose. It is not patched with a cast or with the old signer.

Once this protocol is approved:
- that file is replaced by the canonical round trip in §3;
- B1/B2 and R5 are implemented;
- `finalizeRestoredStaffIdentityInTransaction` gains its canonical branch (refuse source identity rows; keep the target in maintenance).
