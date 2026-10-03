# Temporary, single-advisory braces disposition

This exception is limited to **GHSA-vfj7-8cjw-p6xm / CVE-2026-93687**, the
npm package **braces**, installed version **3.0.3**, affected range **<=3.0.3**.
The user approved these exact conditions on 2026-10-03. It grants no exception
for another package/advisory, even a low-severity finding.

The local mitigation retains the official name/version/package metadata and MIT
license. It is not an official fixed release. The original parser and recursive
AST walkers can exhaust the stack on deeply nested input; the reviewed local
patch bounds parsing and independently validates external ASTs before recursion.
It does not claim to eliminate every resource-exhaustion risk. See
[patch rationale and independent compatibility fixture](BRACES_SECURITY_CANDIDATE.md).
That document and the original provenance status describe the earlier candidate
checkpoint; this document describes the subsequently authorized conditional gate.

## The raw report remains unchanged

`npm audit --json --audit-level=moderate --registry=https://registry.npmjs.org`
continues to return **six HIGH findings, exit 1**, for this identity. The six
package-level findings are propagation of one advisory, not six independently
remediated CVEs. The runner prints full raw stdout and stderr for every attempt
and retains their exact bytes, process status/signal/error and timestamps in the
allowlisted CI audit artifact. No counts are subtracted, no package names are
wholesale ignored, and no full-report findings are removed.

A valid report alone cannot make the exception pass. `scripts/ci-audit.mjs` must:

1. Verify complete counters and the entire advisory graph, including causes,
   effects, paths and subprocess outcome. Every cause must terminate only at the
   exact source-pinned advisory. Additional advisories of any severity, graph
   cycles, dangling causes, contradictory statuses and malformed data fail
2. Capture a separate fresh production-only audit with zero moderate+ findings
3. Invoke the independent verifier to validate all actual installed copies,
   consumers and runtime dependency graph, plus fresh official evidence

The existing pure `lib/ci-audit.ts` moderate-threshold contract and malformed
counter regressions are retained. The CLI's former metadata-only/low-only success
fixtures are deliberately tightened: while this exception exists, metadata-only
reports and every additional advisory fail. Failed/incomplete npm runs retain
bounded retries and ultimately fail closed. An unavailable verifier or official
endpoint is never treated as a successful audit.

## Independent source, install and graph checks

`node scripts/verify-braces-exception.mjs` is independently runnable. It executes
fresh full and production audits itself; it does not accept saved reports,
invented exit statuses, an offline mode or skip flags.

`lib/braces-exception-pins.mjs` is the separately reviewed trust boundary. It pins
patch and provenance SHA-256, original archive SHA-256/SHA-512, candidate archive
SHA-512, and the complete 11-file patched inventory. The verifier never derives
expected hashes from a mutable vendor manifest. A changed source plus a rewritten
manifest still fails. Changing these pins requires independent patch and verifier
review, not automatic regeneration.

The installation check reconciles the root package/lock declarations and all
installed package identities/dependency maps. It scans every installed file tree,
including nested directories not reported by npm audit, and verifies every braces
copy's complete file inventory and hashes. Missing files, additional executable
files, changed versions, unknown copies, unmanifested Node directory/file shadows
and unsupported links fail. Canonical `.bin` symlinks must resolve inside the
installation to actual files declared by an installed package's binary manifest.

Consumer edges use Node's actual package lookup paths; braces entry resolution is
checked explicitly. All consumers must resolve verified copies. Starting from
root production/optional/peer dependencies, the verifier traverses actual
installed dependency resolutions and rejects every path reaching braces. A
`dev: true` flag or production audit alone is not a runtime proof.

## Fresh official evidence and mandatory retirement

Every successful invocation fetches the official GitHub advisory, the current
GitHub list affecting `braces@3.0.3`, and the official npm registry version list.
The reviewed advisory update is `2026-10-02T22:36:34Z`; at review, official latest
is 3.0.3 and no first fixed version is published. Identity, CVE, ecosystem, range,
security-material description/CWE/CVSS, withdrawal/fix status and update timestamp
are pinned. New/missing/changed advisories, any new official version (including a
prerelease/backport), changed official integrity, HTTP/JSON/schema/network failure
or unexpected pagination blocks CI. These are checks on CI/verifier runs, not a
promise of perpetual background monitoring.

As soon as an official corrected release exists, do not update the exception pins
to keep passing. Remove the local dev dependency/tarball disposition, upgrade all
actual consumers to the verified compatible official fix, remove this temporary
policy and its CI/Docker verifier hooks, retain the ordinary fail-closed full
moderate+ audit gate, and rerun the entire release matrix. Never use `--force`,
`audit=false`, a lower threshold or package/version disguising to retire it.

## Actual shipped runtime proof

After both the production app build and packaged read-only preflight build,
`node scripts/verify-braces-runtime.mjs` is mandatory in CI and the Docker builder.
It requires and inventories `.next/standalone`, `.next/static`, `.preflight`, app
build identity, runtime NFT traces and source-map provenance. It rejects actual
braces packages, resolvable directory/file shadows, known braces source bytes,
explicit imports and known embedded code identities. NFT/source-map inputs
(including sourceRoot and indexed maps) are checked for braces; preflight's
bundler package inventory must exclude it and its manifest hashes must match the
actual shipped bundle/notices. A copied root manifest merely declaring the dev
package is not confused with an installed copy.

The runtime walker accepts only the observed generated `pg` and
`@electric-sql/pglite` 16-hex aliases under `.next/node_modules`. Their relative
links must point to the corresponding canonical production package inside the
same shipped artifact; package/lock identity and build/shipped manifest hashes
must match. Every physical target file is still scanned. Exact build, shipped
and NFT alias sets must agree, and the proof records each link and target.
Unknown, extra, broken, chained, cyclic, escaping or braces-targeting aliases
remain blocking. Installed dependency-source inventory keeps its separate strict
symlink policy unchanged.

The exact-file runtime proof includes build ID and root package/lock digests.
Freshness comes from the clean CI/Docker checkout and the immediately preceding
mandatory builds; running the verifier on an arbitrary old directory does not
prove a rebuild. Missing artifacts never skip verification. This establishes the
specified npm-package exposure boundary; it is not a universal security audit of
opaque internals in unrelated third-party compiled bundles.

## Review and release requirements

Negative fixtures cover removed patch/guard, source/version/hash/archive changes,
rewritten provenance, extra/unpatched/unmanifested copies, file shadows, symlink
escapes, actual production-chain reachability, new advisories, official fixes,
malformed/network/process failures, missing runtime artifacts and bundled inputs.

Passing these focused fixtures does not establish application correctness or a
successful full installation. Independent patch **and** verifier review plus the
full required CI matrix remain mandatory: typecheck, lint, unit, PostgreSQL 18,
operational journeys, production build, packaged preflight, actual runtime proof,
HTTP/security/browser checks. Merge and Railway Production deployment are blocked
until that evidence and all review blockers are resolved. No patient data,
production mutations, credentials or backups are used by these verifiers.
