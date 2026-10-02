# Direct operational verification safety

## Scope and evidence boundary

`verify:ceph` and direct `verify:ci` are mutating local/CI tools. Their names do
not mean read-only: ceph creates a temporary database, initializes schema and
synthetic clinical fixtures, then removes that database. Neither the shipped
Docker entrypoint nor the normal application start command invokes these tools.

The previous direct entry points did not establish target safety before pg
construction or child launch. Preserved Railway project identity could also make
the application resolver replace ceph's temporary pathname with its canonical
application database. This was reproduced with mocks and the pure resolver;
no actual Production execution, mutation, or historical damage is established.

## One policy, explicit database roles

`lib/verification-target-policy.mjs` is pure and usable by plain Node. It owns
the existing database alias inventory, known Railway runtime-marker inventory,
host predicates, and the canonical connection-query allowlist introduced in
PR185. `lib/env-contract.ts` preserves its public exports and broader static
diagnostic behavior; the ownership harness delegates to the same pure policy.

- Direct mutating ceph/CI execution permits only `localhost`, `127.0.0.1`, or
  `::1`, even when a remote target is classified test/development/staging
- Original production classifications and known Railway runtime markers are
  rejected before a URL rewrite, Client construction, runtime import, or child
  launch. Explicit database classifications use the application's trim/case
  normalization. Unrelated Railway CLI credential variable names are not runtime
  identities and do not themselves cause rejection
- Every configured runtime alias, TEST_DATABASE_URL and SOURCE_DATABASE_URL is
  checked. Query parameters permit at most one `sslmode=disable`; encoded
  overrides, duplicates, host/database overrides, and SSL-file options fail
- Operational raw URLs must have no surrounding whitespace, literal spaces,
  ASCII control characters or malformed percent escapes. Properly percent-encode
  spaces. This prevents differences between WHATWG URL parsing and pg's raw
  connection-string preprocessing. Ceph passes its selected validated URL's
  serialization to pg; direct CI validates accepted original aliases before
  forwarding them unchanged
- Maintenance accepts any explicit nonempty local database name. The documented
  maintenance URL uses `/postgres`; it is not renamed to `/aqlan_p1_test`
- Ownership/integration still requires the exact database `aqlan_p1_test`, with
  its existing error contracts. Database-name interpretation matches pg, including
  one leading path separator and reserved percent-escape behavior. Malformed
  percent escapes anywhere in a serialized URL, including a fragment, and invalid
  credential encoding are rejected before client construction
- Ceph selects `SOURCE_DATABASE_URL ?? DATABASE_URL`. An explicitly empty or
  invalid SOURCE is not rescued by fallback. A standalone SOURCE maintenance URL
  is sufficient; TEST_DATABASE_URL is not required by ceph
- Ceph is PostgreSQL-only and rejects exact `USE_LOCAL_DB=true`, matching the
  application's backend selection. Direct CI retains its existing local-fixture
  phase and missing-maintenance PostgreSQL SKIPs; SKIPs still fail its summary

There is no remote override flag. The static `verify:environment` diagnostic
continues to recognize explicitly classified remote development/test/staging
targets outside CI; that diagnostic does not authorize these mutating entrypoints.

## Owned temporary-database lifecycle

Ceph uses a `ceph_check_` UUID identifier below PostgreSQL's identifier limit.
Only a successful CREATE grants that invocation ownership for cleanup. A failed
connection or CREATE, including a name collision, never issues DROP.

After successful creation, ceph closes its imported runtime pool, drops exactly
its own generated database, and ends the admin connection. Cleanup is also
attempted after journey failure. Pool-close, DROP, and admin-close failures cannot
produce a success result; later cleanup steps still run. The maintenance database
and unrelated existing databases are not cleanup targets.

## Verification

The direct-entry suite imports the actual scripts with mocked environment
loading, pg, runtime bootstrap and operational spawning. It covers zero-effect
rejection, source precedence, all aliases, encoded/duplicate query overrides,
original-marker preservation, driver-parser ambiguity, native plain-Node
compatibility, successful synthetic clinical responses, CREATE ownership,
same-timestamp uniqueness, pool shutdown ordering and cleanup failures.

The original baseline had 117 expected failures and 18 passing controls across
135 cases. Additional parser and backend-selection regressions were added during
independent review. Focused ownership/target/environment/read-only-preflight
regressions are retained. Stable errors are `VERIFICATION_UNSAFE_TARGET`, the
existing `POSTGRES_TEST_UNSAFE_QUERY`, and `CEPH_CLEANUP_FAILED`.

Final local validation passed 473 focused tests across six files, targeted lint,
focused TypeScript, and native plain-Node entrypoint controls. Independent review
also compared 1,512 accepted synthetic URL combinations against the installed pg
parser. Root's separate direct/ownership rerun passed 302 cases. The earlier full
repository typecheck was killed with exit 137 before diagnostics; it was not
repeated or counted as a pass. Exact-head full CI remains the aggregate gate.

A real run on a freshly initialized isolated loopback PostgreSQL 18.4 cluster
passed the clinical journey (49 reference definitions, 42 computable stamped
measurements, seven missing-landmark expectations). Afterwards, the generated
database was absent, an unrelated synthetic sentinel remained, no ceph sessions
remained, and the maintenance database's public schema stayed empty. The synthetic
cluster was stopped after verification. This is local evidence, not Production
data verification.

All 11 packaged read-only preflight tests pass, including isolated help, rejected
apply, and tampered-manifest cases. An esbuild metafile inspection confirms the
same 12 reviewed local sources: this pure verification module is not reachable
from that artifact, so its closed source inventory and integrity policy require
no expansion. The existing orchestrator's real `npx tsx` fixture checks encountered
a local Unix-socket EPERM restriction; direct mocked/native-Node controls pass,
and the unchanged subprocess workflow remains subject to exact-head CI.

Full exact-head CI, independent/root review, merge, and release verification are
required before declaring this operational slice released. Application connection
selection, `lib/db.ts`, startup, migrations, clinical fixture logic, and financial
behavior are outside this change.
