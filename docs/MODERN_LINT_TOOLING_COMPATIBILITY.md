# Modern lint tooling compatibility candidate

## Scope and provenance

Independent candidate based on main `6a6bdc0cc705874fd4ff6d0f0ddc3fdcd314e9e6`.
It does not import the prescription or A4 candidate branches. Existing AI UI changes
are compatibility-only; no new AI capability, endpoint, permission or provider is added.

The official [minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
marks versions below 11.0.1 affected. This candidate uses the original registry
`minimatch@11.0.3` archive, not a shim, renamed package, patched old release or audit
exception. Three narrowly pinned consumers override their minimatch requirement:
`eslint@10.14.0`, `@eslint/config-array@0.23.5`, and
`@typescript-eslint/typescript-estree@8.70.0`. The reviewed override guard rejects
unlisted consumers, broader predicates, aliases, local paths and alternate versions.
Existing parser hardening overrides remain intact.

ESLint 10.14.0 and React Hooks plugin 7.1.1 use their supported flat configuration.
The project Node contract is `>=22.13 <23`, npm `>=10.9 <12`; see the official
[ESLint 10 migration guide](https://eslint.org/docs/latest/use/migrate-to-10.0.0).
The existing @eslint/js and TypeScript-ESLint recommendations are not opportunistically
upgraded. No force install, legacy peer resolution or disabled safety rule is used.

## Rule migration is not claimed to be exact equivalence

Hooks 7.1.1 upstream removes `component-hook-factories` from its recommended preset
and retains that rule as a deprecated no-op. This is explicitly an upstream behavior
change, not a local suppression. The candidate retains `static-components`, `refs`,
`immutability`, purity, memoization and Rules of Hooks checks. Executable positive and
negative component-factory probes demonstrate the actual remaining protection;
they do not prove equivalent detection of every possible custom hook factory.
The new recommended `void-use-memo` rule is retained. Existing warning levels,
including exhaustive dependencies and set-state-in-effect, are unchanged.

## Compatibility repairs

Render ownership identities are immutable snapshots. Commit-time refs hold live
request/command ownership, while React state holds values actually rendered.
Synchronous duplicate-write and stale-authority fences are not replaced by delayed
state updates. Financial and clinical requests retain their original routes and
payloads. Async decoders/permissions are published at commit, not during a render
that React may abandon. Memo dependencies are complete; event actions are distinct
from render descriptors. Clocks and canvas initialization run in events/effects,
with lifecycle cleanup. Updaters remain deterministic under replay.

Tests exercise real component handlers with synthetic data. Where lightweight
React mocks lacked stable state setters, dependency-aware memoization or layout
effect cleanup, those mocks now follow React's contract; existing safety assertions
are retained. Frozen identities, abandoned renders, A→B→A transitions, stale replies,
double commands, failed refresh, signature receipts, alert revisions and deterministic
updater replay are explicit regression targets.

## Release gates

Focused development results are not deployment approval. Require exact-head clean
npm ci and npm ls, raw full/production audits, reviewed dependency integrity checks,
full lint, typecheck, unit/PostgreSQL/HTTP/browser/print CI, build/runtime dependency
exclusion, independent review and Stage validation before merge or deployment.
A development-only node_modules symlink used for initial focused tests is not a
clean-install or installed-tree integrity proof. Resource failures must be reported
as incomplete gates, never converted to success or worked around by weaker checks.
