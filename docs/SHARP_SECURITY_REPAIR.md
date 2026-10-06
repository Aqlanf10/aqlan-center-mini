# Official sharp security repair

## Why the audit stopped

The root lockfile shared by released main
`ea312ad872897b07ad2241c09084837dee355dae` and PR268's
`ed8a80cbc04ce3d3f0e6f1f2b3b561a9f5c80365` was unchanged when
[CI1462](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37525829482)
received a new HIGH finding for sharp 0.35.4. The complete raw report contained
the existing six braces-chain nodes plus sharp. The unchanged gate rejected
the additional advisory; production audit and later application gates did not
run in that failed job.

[GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
identifies sharp before 0.35.5 through upstream librsvg CVE-2026-96889.
The maintainer advisory was published September 30, 2026 and entered the GitHub
Advisory Database on October 6. Its stated impact depends on runtime-specific
conditions, including glibc-based Linux. A locked vulnerable dependency does not
by itself establish deployed request reachability or exploitation.

Sharp is an optional production dependency of Next 16.3.8, whose existing range
is ^0.35.4. It is not a development-only package. The application has no image
configuration enabling SVG optimization; the locked Next default rejects SVG.
The repair nevertheless updates the actual image-processing dependency rather
than creating another audit exception.

## Minimal official dependency change

Only the root lock's 27 existing sharp-family package entries change:

- sharp and the corresponding @img/sharp native/WASM packages: 0.35.4 to 0.35.5
- @img/sharp-libvips packages: 1.3.3 to 1.3.4
- Those packages' official resolved URLs, integrity values, internal version
  references and published platform metadata

Package inventory and all unrelated lock entries are unchanged. The root
manifest, Next version, parser overrides, existing braces package and every
braces gate are unchanged. The isolated braces consumer fixture contains no
sharp or Next package; its manifest and lock remain byte-identical.

[Official sharp 0.35.5](https://github.com/lovell/sharp/releases/tag/v0.35.5)
uses [sharp-libvips 1.3.4](https://github.com/lovell/sharp-libvips/releases/tag/v1.3.4),
which supplies libvips 8.18.7 and librsvg 2.63.2.

## Provenance

The isolated generator retrieved exact official npm metadata and independently
checked each of the 27 packed archives against its registry SHA-512. It
generated the root lock using npm 11.21.0 on Node 22.23.3, rejected unrelated
changes, and compared installed and shipped native package files with the
verified archives.

- Generated lock SHA-256:
  `5df7ced31497dc6de92937fa41e995e3e7912856f51ade2b56ce4e169dbb3bd5`
- Original lock SHA-256:
  `71b2e92aaf967527d6ee9beaa127191751f9f9f558d508af4af8a67a96988637`
- Official sharp 0.35.5 archive SHA-256:
  `3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac`
- Official sharp 0.35.5 integrity:
  `sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==`

The generated lock is transferred byte-for-byte; no lock metadata was invented
or hand-edited. It is identical across both isolated proof runs.

## Completed isolated proof

[Successful run 37531099487](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37531099487)
ran exact proof commit `3847b4d2ef9f1d285dbcb00c2ef7e7b1aebd2ce9`,
tree `39607f4e60b733b411e63f7d88809afe9a6c180d`, based on released
main `ea312ad872897b07ad2241c09084837dee355dae`.
The [exact artifact](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37531099487/artifacts/11444481940)
has ZIP SHA-256
`a9c8d4bafc7e74c89904f772a5783cae14da52f771fb310894185e62d0d81b36`.

Evidence includes complete unmodified full and production audit stdout/stderr
and real process outcomes, official package metadata/archive and file hashes,
the npm-generated lock/delta, installed-package proof, unchanged consumer
chains, actual Docker build output, container isolation and runtime results.

- Full audit retained exactly six HIGH braces-chain nodes; its process exited 1.
  The existing independent braces verifier passed all fresh official,
  installed-copy, graph and source/archive checks.
- Production-only audit contained zero findings; its process exited 0.
- The unchanged four-chain braces consumer fixture passed.
- The actual repository Dockerfile built the application and preflight artifact.
  Its unchanged runtime verifier established braces absence across 5,902
  shipped/provenance files and 288 traces.
- Both glibc 2.36 and the actual Alpine/musl standalone runner loaded sharp 0.35.5,
  libvips 8.18.7 and librsvg 2.63.2. The loaded native module and shipped package
  bytes matched their verified official archives.
- Both environments passed bounded synthetic PNG, JPEG, WebP and SVG operations,
  the actual Next PNG optimizer, and default SVG denial. These were benign
  fixed rectangles, with no external resources or exploit baseline.
- Image execution used network-disabled, read-only containers with resource and
  time limits. The actual Alpine runner used UID 1001.
  Its image ID was
  `sha256:11722aae3e126b63d433a229c5e83a2c38e161d4ab992accf28a50ed61c7b8bc`.

The earlier run 37529969892 passed lock/audit/build checks but failed a proof
harness assumption about the native filename. Official 0.35.5 includes the
version in that filename. An independently reviewed exact-path assertion
replaced the obsolete pattern; no audit, provenance or isolation check was
relaxed.

## Release boundary

The temporary generation workflow and worker files are excluded from the
release tree. This isolated proof does not replace exact-release-head full CI,
PostgreSQL integration, HTTP/browser security checks, independent review or
exact-commit Railway verification. No Production services, credentials, patient
records or database operations were used in the isolated proof.
