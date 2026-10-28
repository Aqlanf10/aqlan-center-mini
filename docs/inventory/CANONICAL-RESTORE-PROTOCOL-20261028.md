# Target-side restore protocol for canonical inventory history — PROPOSAL for review

Status: **proposal, not implemented**. Written for Dot's review (6458434508: "restore must not import the source realm or execution history; it needs a reviewed target-side protocol"; 6475545205 item 5: "review the target-side recovery protocol before M3a implementation").

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

- **R1. The target starts marker-free.** It is `migrate` plus the registered proposals (M4). Data is replayed into that schema. The restored target therefore sits in `legacy`/maintenance entry: no canonical issuer, no inventory writer.
- **R2. No identity is adopted.** Nothing copies a source subject, realm or generation into target authority. A numeric `users.id` is never treated as continuity.
- **R3. The owner prepares the target.** The deferred preparation and seal service (tracked in `M1_ENTRY_SLICE_DESIGN.md` §6) runs only after replay. It creates a **target** realm and generation and binds every account to a fresh subject. This is the only route back to canonical entry.
- **R4. Restored history stays inert.** Once the target is ready:
  - **Committed source commands.** Their business effects (posted invoice, payable, stock) are present and visible through ordinary canonical reads. Their acknowledgements are **not** replayable: there is no subject continuity, and a terminal-outcome read needs the separately governed historical read binding, which is not built.
  - **Retired source commands and rejections:** inert evidence.
  - **Pending source intents:** never executable and never retirable through the normal path (realm/subject/generation mismatch). They keep their invoice "unresolved", so a new intent for the **same** invoice is durably rejected. Independent invoices proceed.
- **R5. Explicit owner recovery (to implement after approval).** This releases a held source intent. It would be a canonical operation under `inventory.supplier-invoices.cancel` (or a narrower owner-only action if the review prefers). It:
  - accepts only a source intent whose realm or generation differs from the target's;
  - takes the exact original operation lock;
  - proves no committed result exists in the restored data;
  - records an append-only retirement for the original command key, with a bounded reason;
  - audits the **releasing** canonical actor separately from the stored source actor snapshot.

  It never executes the source command and never re-keys it.

## 3. Acceptance after approval (replaces the old same-realm restore suite)

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
