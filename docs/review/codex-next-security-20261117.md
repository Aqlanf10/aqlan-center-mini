# Next.js patch gate for the grouped-lab follow-up

Independent branch: `codex-lab-next-security-20261117`, derived from the published laboratory repair `6dc2a6af32f92a729519194d705e2a67bf59d553`. It contains the laboratory fixes and all their unfinished separation limitations described in `codex-lab-followup-20261117.md`. This is not a completed non-orthodontic release candidate.

The unchanged dependency gate on Next 16.4.2 failed with one moderate finding, GHSA-mfr8-8qww-v76h (CVE-2026-119790). The official advisory identifies 16.4.5 as patched: https://github.com/advisories/GHSA-mfr8-8qww-v76h . The patch pins Next to 16.4.5 and updates its lockfile entries (`next`, `@next/env`, optional SWC platform packages). No audit exception, test assertion, role or release gate is relaxed.

Verification on Node 22.23.5:

- Locked `npm ci` succeeded.
- 284 dependency/audit tests passed (8 files).
- Full and production npm audits both returned zero findings. The complete `ci:audit` gate passed, including the live official withdrawn-braces advisory and installed-package proof. The first attempt could not fetch the official evidence because Node was not using the environment proxy; rerunning with `NODE_USE_ENV_PROXY=1` passed with the same gate code.
- Next 16.4.5 build passed, with the existing dynamic-filesystem tracing warning. The standalone preflight artifact build/smoke passed (73 migration assets).
- The built-application grouped-lab browser suite passed 3/3 on system Chromium and an isolated synthetic PostgreSQL database, including the tooth-price display and unauthorized-doctor price omission.
- The laboratory production source is otherwise identical to `d0babec218a8db38d96f85a1bad9105d0904ca49`, whose 54 targeted PostgreSQL cases passed. This is source-lineage evidence, not a new full PostgreSQL run on the dependency patch.
- The source inventory was regenerated after the sole-doctor change. This only updates its digest; NOT_READY and all permission classifications remain unchanged.
- Test discovery previously included two generated `.next/standalone/scripts/audits` copies, whose copied source inventories drift after a build. Added only `**/.next/**` to the unit discovery exclusions. Before/after discovery comparison retains all 894 original test files and removes exactly those two generated copies. All 10 original audit-inventory tests passed after this change. The original PostgreSQL/HTTP jobs and every source assertion remain intact.

At report creation, the full local unit run on the unpatched dependency branch and runtime artifact proof were still running; no full combined pass is claimed. Final results and final-head hosted CI status are reported in the delivery message.

No merge, pull request, deployment, live database access or account/permission mutation occurred. Railway source configuration was checked read-only: both web services track `main`; this branch is not a deployment source. Only source, tests, dependency manifests and review documentation are published. All 0079 / finance / Rx / 0134 / adjustment-comparison / upgrade-rehearsal limitations of the laboratory report remain open.
