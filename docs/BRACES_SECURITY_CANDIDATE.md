# Local braces security candidate: review only

This is a local, independently implemented mitigation candidate for
[GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
It is not an official upstream release. The repository pins it as an explicit
development-only local artifact. Integration remains under review; raw npm audit
still reports the advisory. A separately reviewed verifier and narrowly scoped
disposition are required before release.

## Source and identity

- Base: the official npm `braces@3.0.3` tarball, fetched with lifecycle scripts
  disabled and verified against the SHA-512 integrity already in this repository's
  lockfile
- `vendor/braces/` preserves the original package name, version, package metadata,
  public entry point, README and MIT license
- `vendor/braces-provenance.json` records the official artifact URL/integrity and
  SHA-256 hashes of every original and candidate file
- Its status/audit commentary is retained as immutable metadata from the original
  `f6c8fcf` checkpoint; the source hashes remain the current verified contract.
  This document describes the later package integration state
- `vendor/braces-security.patch` is the reviewable source delta
- No source from the unmerged contributor PR was imported or executed

As checked on 2026-10-03, the official registry still publishes 3.0.3 as latest;
the advisory lists no fixed version. The official master parser/compiler still
lacks a nesting guard. [Upstream PR 72](https://github.com/micromatch/braces/pull/72)
is open; its existence and a non-maintainer review do not establish an accepted
maintainer fix.

## Candidate behavior

1. The parser rejects more than 128 nested brace/parenthesis groups before creating
   another container. Quoted, escaped and bracket-contained delimiters retain
   their original interpretation. The existing character/range guards remain
2. `compile`, `expand` and `stringify`, including direct `lib/` imports, validate
   caller-supplied ASTs with an iterative traversal before recursive processing
3. Cyclic/repeated child graphs, malformed non-string values and dangerous
   parent/queue graphs are rejected. External ancestor expansion queues are also
   bounded. This preserves the detached parent references that the original parser
   creates while flattening unmatched groups
4. The nesting bound is fixed and cannot be disabled by an option. Rejection is a
   deliberate error with `BRACES_NESTING_LIMIT` or `BRACES_INVALID_AST`; callers
   remain responsible for handling invalid input errors

This targets stack-exhaustion and malformed-AST recursion. It is not a claim to
eliminate every possible resource-exhaustion input or every security issue in the
package/toolchain.

## Scope and exposure

All seven affected lockfile paths are `dev: true`: `braces`, `chokidar`,
`micromatch`, two `fast-glob` paths, Tailwind and Next's ESLint plugin. They form one
root advisory propagated to six package names, rather than six independent CVEs.
The diagnostic production-only audit reports zero findings; it does not replace
the full gate or establish zero runtime risk.

No direct application imports of the affected packages were found. Tailwind's
PostCSS build scans repository-controlled app/component content globs; its CLI
watch mode uses chokidar. The ESLint helper expands configured Next root-directory
patterns. Docker installs all development dependencies in its build stages and
copies standalone output into runtime. The exact deployed Production artifact was
not inspected, and build/developer supply-chain exposure remains relevant.

## Verification boundaries

The focused tests compare the candidate against a separate official archive at
`vendor/upstream/braces-3.0.3.tgz`, never application `node_modules/braces`. The
fixture loader verifies the pinned SHA-512 before extraction and every original
file's SHA-256 before loading. Its regular-file allowlist rejects unrecorded,
modified or non-regular entries. The verified original modules are loaded only
from that fixture; only the original external `fill-range` dependency comes from
the locked consumer tree. Future installation of the candidate cannot turn the
test into a self-comparison. Hostile cyclic/DAG/ancestor-queue regressions use
separate Node processes with a 5-second timeout and 64-MiB heap. Normal parser/
compile/expand/stringify comparisons cover valid, unmatched and option-sensitive
patterns.

An isolated npm 11 scratch override first proved that a packed local tarball,
still identified as `braces@3.0.3`, remains visible to the registry audit. The final
packaging uses an explicit `devDependencies.braces` file spec, with no override:
`file:vendor/braces-3.0.3-local.tgz`. This avoids npm's relative override path
ambiguity. Only that root dev-dependency edge and the braces lockfile URL/integrity
change; all other package entries stay unchanged. **npm audit still submits the
identity to the registry and returns the advisory and six HIGH findings, exit 1.**
No advisory coverage is hidden or dropped. Audit-disposition implementation is a
separate reviewed change, not part of this package patch.

A full 403-package scratch `npm ci --ignore-scripts` attempt was killed with exit
137 despite a 384-MiB JavaScript heap cap. That attempt does not prove full clean
installation or application correctness. Focused consumer installation evidence,
when available, is narrower than full CI.

The initial checkpoint's focused checks are preserved in
`vendor/braces-review-evidence.json` (commit `f6c8fcf`):

- 49 tests pass: 37 patch/security tests, 3 source-provenance tests, and the 9
  unchanged audit-gate tests; the compatibility loops include 1,356 comparisons
- A 160-package consumer-only clean installation succeeds with a 192-MiB heap,
  one registry socket and lifecycle scripts disabled; its lockfile is unchanged
- All four installed consumer chains resolve the same candidate, with every one
  of its 11 source files matching the recorded hashes and the depth guard present
- Four fast-glob/micromatch fixture patterns match the official baseline. A bounded
  Tailwind fixture using the existing theme config produces identical 12,122-byte
  CSS output. This is not an application build or comprehensive visual test
- The new guard and test files passed focused ESLint. At that checkpoint the app
  lint policy rejected 16 CommonJS imports in vendored source. The later integration
  allows CommonJS import syntax only in the five named upstream modules that use
  it; every other rule and first-party file remains covered. That narrow config
  change needs its own final validation

Source/file evidence is review material, not an implemented production attestation
or an authorization to change the gate.

The later direct-dev package integration evidence is separate in
`vendor/braces-integration-evidence.json`: 54 focused tests and scoped lint pass;
the repeatable direct-package consumer harness passes with auditing enabled; both
full reports retain six HIGH findings and production-only audit has zero findings.
The existing installed dependency projection traverses 119 paths with no braces.
It includes two pre-existing extraneous sharp/WASM packages, recorded explicitly.
That projection uses the shared reference installation, not a clean candidate
application install. The fresh patched installation proof covers the consumer
fixture; final full CI must verify every actual application-installed copy and
the built runtime artifacts. No full application install/build was retried.

## Reproduce the consumer proof

The additional packaging work does not amend the original `f6c8fcf` checkpoint or
its evidence. The committed manual harness is:

```sh
# Use the repository's supported Node 22 and npm 11 first.
node scripts/dependency-review/run-braces-review.mjs
```

Run this only in a coordinated quiet validation window. It creates an isolated
temporary workspace and retains its result/logs; it does not install into the
application or modify its package files. It performs serial bounded commands with
a 192-MiB JavaScript heap, one npm registry socket, 120-second command limits and
30-second consumer-worker limits.

The consumer manifest/lock live in
`scripts/dependency-review/consumer-fixture/`. Their exact versions and local
candidate tarball integrity are pinned. `braces-review-contract.json` contains all
four consumer chains, the exact four glob patterns, raw Tailwind class fixture and
CSS input. The harness packs the candidate, checks its tarball against that lock,
and performs a consumer-only `npm ci --ignore-scripts --audit=true` with
lockfile-stability verification. Install-time auditing stays enabled; explicit
full-tree and production-only registry audits are also mandatory evidence.

Two fresh worker processes run identical installed consumers and inputs. The
official worker substitutes only exports loaded from the separately verified
upstream archive; the candidate worker uses actual installed candidate exports.
Each proves all resolved consumer paths, complete file inventories/hashes and the
appropriate guard/negative-control behavior. The harness compares glob results and
the complete CSS bytes, not just a pre-recorded hash.

Finally it audits copies of the complete application lockfile, before and after a
scratch-only development dependency on the tarball, without installing the full
application. The official comparison graph has the same explicit dev edge, pinned
to registry `braces@3.0.3`. The permitted delta is that edge's file spec plus the
braces resolved URL/integrity. Both raw reports
are retained and must have matching registry discovery. Missing/malformed audit
evidence fails this manual proof. A known advisory remains a release blocker;
successful reproduction does not grant a disposition exception.

The final package uses no override, forced upgrade or lifecycle patch script.
Existing consumer ranges accept the local artifact's unchanged 3.0.3 identity.
The Docker dependency stage copies only the exact local tarball before `npm ci`;
a runtime-absence verifier runs after both build commands. The runner stage stays
unchanged and must not receive vendor, tests or proof sources.

## Required independent review before publication

The owner approved only a conditional disposition for this exact advisory and
package/version, subject to an independent fail-closed verifier and full CI. The
package work here does not implement that gate decision. Raw audit must remain
visible, and every other advisory must remain blocking. Separate reviews of the
patch and verifier are required before merge or Production deployment.

The separate conditional disposition must retain the raw
report and original package identity; validate the whole advisory graph; cover
every actual installed consumer path with pinned source/artifact hashes; require
security regression proof and fresh upstream-advisory checks; and fail closed on
missing/malformed evidence or newly uncovered advisories. The current runner's
legacy registry-outage behavior cannot serve as that attestation's fallback.
Subtracting a count, ignoring all development dependencies, changing the threshold
or renaming/version-disguising the package is not an acceptable substitute.

The smallest alternative is to wait for a verified compatible official fix and
then rerun full installation/CI. A separate toolchain migration would have wider
CSS/browser and lint-compatibility risks and is outside this candidate.
