# Canonical inventory item-create lifecycle (unbound)

`commandCanonicalInventoryItemCreate` is a server-only, transaction-owning seam, not
an HTTP route or activation mechanism. Its only action is `item.create`; its modes
are `admit`, `execute`, `lookup`, and `retire`. Integration opt-in, immutable intent
validation, mode validation and schema validation occur before pool acquisition.
Every mode requires a genuine verified durable session and exact central
`inventory.items.create`, whose prerequisite is `inventory.references.view`.
Non-owner admins need explicit grants just like other supported active roles.
Protected-owner semantics are unchanged. Policy version is 3; document schema is 1.

The original protocol envelope is copied and frozen before awaits. The operation
key remains `reference:SHA256(JSON.stringify([realm, subject, nonce]))`; the digest
covers the full original intent, including generation. Realm, subject and generation
must match current proof in every mode, before journal evidence is read. Original
username mismatch is held, not rewritten or treated as historical continuity.
No historical verifier, nonce reminting, result-only legacy adoption or generation
rewriting is available.

The central runtime establishes lifecycle, account and provider locks before the
shared reset fence. Exact opaque handle/client/action/XID/schema proof is repeated
before that fence, after it, after the same exclusive operation-key lock, before each
binding/audit/item/unit/result/retirement write, and finally before commit. The
runtime's frozen identity projection supplies audit identity, never authorization.
The lower narrow facade accepts no caller actor, principal, management flag,
namespace, authority callback or arbitrary domain-work callback.

The existing private command lifecycle is shared: scope `reference.setup`,
management `true`, original key/digest, binding and `created_xid` semantics remain.
The legacy exported factory and role-based supplier helpers retain their previous
behavior. Canonical item creation does not fabricate an admin or pass management
false. Each admission commits separately; same-top-level-XID admission cannot
execute or retire, even across savepoints. Admission and its audit commit together.
Execution commits item, unit version 1, audit and journal result atomically.
Retirement uses the same operation lock and terminal guards as execution. Exact
replay returns stored results without writes; changed content conflicts; absent
result on an admitted command is pending, not evidence of failure. Failed commands
roll back row changes, not PostgreSQL sequence consumption.

Every shared SQL target is qualified with the validated runtime schema. Because the
existing proposal's terminal trigger bodies use unqualified internal references,
the facade also binds transaction-local `search_path` to
`pg_catalog,<validated schema>,pg_temp`; explicit temp-last placement prevents
temporary relation shadowing. The prior setting is restored when returning to a
trusted transaction caller; aborted transactions restore local settings at rollback.
Lower-facade callers must roll back after any failure, including uncertain SQL or
transport failure; a caught exception is not permission to continue and commit.
No trigger guard is removed or disabled.

Acceptance uses real PostgreSQL and actual signed canonical runtime verification
in a hypothetical trusted-ready-v2 fixture. This is not production bootstrap,
issuance, live grants, installation, supplier accounting, restore replay or route
activation. No future AI/Dot functionality is included.

## Bounded verification checkpoint (2026-10-27)

Production source is unchanged between aggregate checkpoint
`cd77cdb7a4f7a7eb5adb50a86136177727c912b4` (tree
`d382d5d088a4da0c1d30643026ee669a407c93ae`) and the final reviewed test
checkpoint `cc93565abdc510d560661fc677d128b5cc8c3e58` (tree
`21eb5731d06a2f5db41b319d8b72457368affe55`). The follow-up changes only
acceptance tests and documentation; earlier financial/HR evidence remains attributed
to its original checkpoint in `LEGACY_SESSION_CALLER_AUDIT.md`.

| Evidence | Exact checkpoint | Result |
| --- | --- | --- |
| Full unit suite | `cd77cdb` | 781 files, 13,134 tests passed |
| Canonical reference/runtime plus legacy lifecycle, reference setup, procurement, supplier finance, receipt adapter, authority maintenance | `cd77cdb` | 8 real-PG files, 134 tests passed |
| Closed rollout/recovery routing, reference contract, capability and durable-session units | `cd77cdb` | 132 tests passed; 4 dedicated item-capability tests also passed |
| Full TypeScript check, Node 22 with explicit 4 GB heap | `cd77cdb` | Passed |
| Scoped ESLint | `cd77cdb` | Zero errors; 8 pre-existing unused-symbol warnings in `db.ts` |
| Final item-create acceptance, including actual SAVEPOINT release/rollback-to and propagated transaction failures | `cc93565` | 51 real-PG tests passed |
| Final full TypeScript check, Node 22 with explicit 4 GB heap | `cc93565` | Passed |

Final focused PostgreSQL evidence is the owned synthetic run `pg18-qkY61HEk`;
legacy regression evidence is `pg18-r9czFM7S`. Both verify PostgreSQL 18, fresh
owned test data, clean source snapshots, and terminal shutdown with `RUN_EXIT=0`.
A canceled intermediate run (`pg18-0zx4bDoo`) supplies **no acceptance evidence**;
its server was separately verified stopped. No real or shared production data was
used or deleted. Dependencies were copied with same-lockfile hardlinks, not a
symlink dependency directory. Heavy runs were serialized by the shared test lock.

Local evidence files are retained under `recovery-evidence-20261027`:
`canonical-item-create-full-unit.log`, `canonical-item-create-regressions.log`,
`canonical-item-create-boundaries-unit.log`, `canonical-item-create-final-static.log`,
`canonical-item-create-followup-types-final.log`, and the owned run directories.
This is **item-only bounded acceptance**, not full inventory activation or full
PostgreSQL-suite acceptance. Existing positive supplier-operational and
restore/authority-restore journeys still depend on obsolete issuance integration;
those tests remain unchanged, without inversions or skip flags, and are not counted
as passing evidence for this slice. Routes, issuance, live grants/schema activation,
other reference mutations, supplier accounting and restore replay remain outside
this checkpoint.
