# Private isolated Ortho reference generation

This companion generator runs frozen source in a fresh database on an explicitly
identified **disposable local PostgreSQL 18 cluster**. It never connects to a
Staging target. It does not approve reconciliation or establish the provenance
of existing objects. The empty-0051 operator and all normal guards are unchanged.

Use a separate cluster built from an independently reviewed immutable image and
platform. Verify PostgreSQL build, libc/ICU and locale-data packages, database
provider/encoding/locale, and natural stored and actual collation versions before
preparing configuration. A matching version string alone does not prove an image
or security recipe equivalent. Never force COLLATION_VERSION, refresh a version,
edit catalogs, or rewrite a reference to make it match.

The JSON configuration has these exact fields (placeholder values require review
and replacement; `null` means exact null, never a wildcard):

```json
{
  "format": 1,
  "disposableCluster": true,
  "cluster": {
    "systemIdentifier": "ISOLATED_CLUSTER_SYSTEM_IDENTIFIER",
    "versionNum": "ISOLATED_PG18_VERSION_NUMBER",
    "version": "ISOLATED_FULL_VERSION_STRING",
    "bootstrapRole": "isolated_bootstrap_role"
  },
  "databaseOwner": "reviewed_database_owner",
  "initializerRole": "reviewed_initializer_role",
  "locale": {
    "encoding": "UTF8",
    "provider": "libc",
    "lcCollate": "REVIEWED_LOCALE",
    "lcCtype": "REVIEWED_LOCALE",
    "locale": null,
    "rules": null,
    "storedVersion": null,
    "actualVersion": null
  },
  "environmentWitness": {
    "imageDigest": "REVIEWED_IMAGE_AT_SHA256",
    "platform": "linux/amd64",
    "libc": "VERIFIED_PACKAGE",
    "localeData": "VERIFIED_PACKAGE",
    "icu": null,
    "approvalId": "private-review-id"
  }
}
```

`cluster` identifies the disposable cluster, not the target. The local bootstrap
role needs CREATE/DROP DATABASE, access to pg_control_system(), and permission to
SET ROLE to the initializer. Both configured roles must already exist. Role
identifiers are deliberately limited to lowercase ASCII identifiers. The tool
creates no roles or grants and provides no arbitrary setup SQL hook. Distinct
object/schema owners, grants, grantors, memberships and default privileges require
an independently reviewed isolated setup recipe; the captured catalog retains
actual security properties without normalization. Unsupported recipes must stop
for review rather than adjust the output.

Create a canonical, user-owned mode0700 output directory outside every checkout.
Set TEST_DATABASE_URL to the owned disposable cluster's numeric loopback endpoint
and database `aqlan_p1_test`, ORTHO_REFERENCE_CONFIG_FILE to the private JSON, and
ORTHO_REFERENCE_OUTPUT_DIR to that directory. Do not load application .env files.
Run with the repository's supported Node version:

```sh
node --import tsx scripts/generate-private-ortho-reference.ts
```

The generator uses a random database from template0, checks its natural locale
before initialization, runs the frozen source, and captures raw catalogs. It
rechecks the created database identity before removing it; it does not force-drop
connections. Success is emitted only after rollback, database removal and
connection cleanup. The CLI has a whole-process deadline as well as connection,
query, lock, statement, idle-transaction and transaction limits. An interrupted
or uncertain creation can leave a disposable database: inspect the private
journal and exact cluster/database identity; do not blindly retry or clean up.

Each output subdirectory is mode0700; reference.json, witness.json and journal.json
are mode0600. Only a journal with state `complete` identifies a completed artifact.
A file-write failure can leave incomplete files, which are not usable references.
The CLI prints only a fixed event and digest on success, fixed categories on error.
The witness labels image/library provenance as not independently verified by SQL;
retain separate image/package evidence privately. Generate twice and compare
digests, then run the frozen approval validator with synthetic identity values
offline. Validator success proves source-structure acceptance only. Independently
review the full raw reference against permitted target metadata before any target
report or action. No live operation is authorized by generation or these tests.

Keep configuration, platform evidence, references, witnesses and journals private.
Do not commit them, add real environment identities to tests, or attach them to a
public pull request. Empty sandbox `.git` marker directories are allowed; any
populated `.git` directory, file or symlink in the output's ancestry is refused.
