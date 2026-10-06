# Official dependency-resolution repair

## Why the dependency gate stopped

The unchanged lockfile at main `212d4740b6862e5fc72631c96bebb7fc96ec451d`
started receiving two additional registry advisories between the successful
[premerge audit](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37396585030)
and the [failed main audit](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37399061071/job/112061984850).
The complete raw report and scoped braces gate correctly blocked the new findings.
The precise registry ingestion/cache event is not known; this was not a new
application dependency change or a network-outage fallback.

- [GHSA-rj75-hqrm-r3gf / CVE-2026-104844](https://github.com/advisories/GHSA-rj75-hqrm-r3gf):
  postcss-selector-parser before 7.1.6 has quadratic flat-selector parsing.
  The locked 6.1.4 copy was used by development-only Tailwind and postcss-nested.
  The upstream advisory distinguishes untrusted request-path selectors from
  ordinary build-time processing of trusted sources.
- [GHSA-68fv-2mgg-jv7q / CVE-2026-93749](https://github.com/advisories/GHSA-68fv-2mgg-jv7q):
  source-map-js 1.0.0 through 1.2.1 permits denial of service using indexed maps.
  The root graph includes it through Next → PostCSS, so it cannot be dismissed as
  a development-only finding. This dependency fact is not proof that a deployed
  request exposes an attacker-controlled source-map parsing operation.

## Bounded dependency changes

Both the application and the isolated braces consumer fixture use the official
source-map-js 1.2.2 release. No direct dependency or source-map override is added.

Tailwind remains 3.4.19, and postcss-nested remains 6.2.0. The root Tailwind
declaration is pinned to the version already locked, avoiding npm EOVERRIDE
without broadening override scope. Both manifests contain exactly:

```json
{
  "tailwindcss@3.4.19": { "postcss-selector-parser": "7.1.6" },
  "postcss-nested@6.2.0": { "postcss-selector-parser": "7.1.6" }
}
```

npm places two official 7.1.6 copies under those exact consumers and removes the
old hoisted 6.1.4 copy. The application and fixture locks must preserve all other
package entries. This avoids a Tailwind 4 migration and preserves the fixture's
actual Tailwind 3 consumer chains.

The independent installed verifier admits only this exact override object.
Missing, extra, unscoped, ranged, aliased, file-based or changed resolutions fail.
Workspaces remain rejected. The braces package is never overridden: its existing
dev-only file specification, source/archive hashes, advisory leaf, fresh official
evidence checks, complete graph validation and actual runtime-absence proof remain
unchanged. No additional advisory, severity or package receives an exception.

## Immutable official package provenance

The isolated generation job retrieves exact official npm metadata, packs the
official releases with lifecycle scripts disabled, and independently checks the
archive bytes against the registry SHA-512. Generated lock entries must match
that metadata and the independently reviewed SRI values:

- postcss-selector-parser 7.1.6:
  `sha512-7qASPzhKF2l2KLboRZux8CCTRMdGiV08vWmyKzPz22qZ7ZjQBOeY7rNzNoCLSUiftJ7HUq0GERHmxw/t0dCdMw==`
  Archive SHA-256: `48c903f98c5591d8d26f16f389d5cb3435459474c645209a79f6241bf4b657b6`.
  Runtime dependencies remain cssesc ^3.0.0 and util-deprecate ^1.0.2.
- source-map-js 1.2.2:
  `sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==`
  Archive SHA-256: `05c8cf8e7c3a6b56cada7668fe9342b10f4b625efc92aba9ba05b9e8fe4d71a3`.
  The published package has no runtime dependencies.

Official release notes:
[parser 7.1.6](https://github.com/postcss/postcss-selector-parser/releases/tag/7.1.6),
[source-map-js 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2).

## Verification and release boundary

The isolated [proof run 37402611024](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37402611024)
passed at commit `674a4b363bea7a11a0884e80ea5db5a949759c56`. Its
[exact evidence artifact](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37402611024/artifacts/11386336289)
has ZIP SHA-256 `b05e760ac2997e324304248bf56fdafb7f1a584dff8ec8d871a9b575c749779c`.
Both npm-generated locks were transferred byte-for-byte: application lock SHA-256
`71b2e92aaf967527d6ee9beaa127191751f9f9f558d508af4af8a67a96988637`,
consumer lock SHA-256
`f311dd806d92b68c5d7a6d3cb515428ab39815276b77ebed6f8e8debfb373160`.
The full raw audit retained the six existing HIGH braces-chain nodes and no
additional advisories; the separate production audit reported zero findings.
The 144,563-byte application CSS and 578-byte nested fixture were byte-identical,
1,673 selector round-trips/transformations matched, and source-map behavior,
bounded candidate security checks and all four braces consumer chains passed.


The isolated generation workflow is temporary and is excluded from the release
tree. It generates both locks using npm, retains raw audit stdout/stderr and
process outcomes, rejects unrelated lock changes, checks actual consumer
resolution paths, and scans installed manifests for additional parser copies.
Baseline and candidate fixtures are separate real installations, with parser
6.1.4/7.1.6 and source-map-js 1.2.1/1.2.2 respectively. Compatibility covers the
actual application CSS, RTL/responsive/arbitrary-selector variants, nested CSS,
selector round-trips and transformations, source-map behavior and the existing
patched-braces consumer chains. Candidate-only security regressions are bounded
and never execute denial-of-service inputs against the vulnerable baseline.

Generation evidence and its final status must be reviewed separately from
release CI. Even successful isolated proof does not establish a full application
installation, PostgreSQL behavior, production build, HTTP/browser safety or a
Railway deployment. Full exact-head CI, both runtime builds and the unchanged
runtime verifier, independent review and exact-commit Railway verification remain
mandatory. No Production database or patient records are used by these fixtures.
