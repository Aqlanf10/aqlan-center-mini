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
before that fence, after it, after the shared operation-key lock, before each
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
