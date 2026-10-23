# Dependency audit gate: withdrawal lifecycle of the scoped braces exception

- **Base:** #439 head `9881d33c21c4812ae3e18219a8112438d6192a78` (`feat/finance-synthetic-verification-20261023`).
- **Separate from the financial work:** this branch is not mixed with #442 and does not touch #429, #438, #439, #440, #441 or #442.
- **Assignment:** approved on #442; Claude is the sole implementation owner.

## What happened

- GitHub withdrew **GHSA-vfj7-8cjw-p6xm / CVE-2026-93687** (braces ≤ 3.0.3) on **2026-10-23**. The advisory page says: «This advisory has been withdrawn because it's not a practically exploitable vulnerability». See https://github.com/advisories/GHSA-vfj7-8cjw-p6xm.
- `npm audit` therefore no longer reports it.
- The scoped exception required that this exact advisory be present, unchanged and not withdrawn. So the gate failed closed on every branch with `BRACES_EXCEPTION_REJECTED: known advisory disappeared`.

## Evidence (exact command `node --import tsx scripts/ci-audit.mjs`, synthetic workspace, no secrets)

- **`before-ci-audit.log`**, on `9881d33c`:
  - every attempt of the full audit is a complete report with `exit 0` and 0 findings of any level;
  - the gate refused after 3 attempts with `known advisory disappeared`, exit 1. This is identical to hosted CI jobs 120566971932 and 120573053809.
- **`after-ci-audit-local.log`**, with this change, in this sandbox:
  - the full audit is classified **withdrawn**;
  - the production audit validates;
  - the real installed tree is re-verified;
  - then the **compulsory** official lookup fails, because `api.github.com` is unreachable from this sandbox, and the gate **refuses**: `official lookup failed`, exit 1.

  This shows that a missing response is never treated as clean. Hosted CI, where the official API is reachable, is the live positive evidence.
- **`red-before.log`**: the new regression suite is red against the unchanged gate (47 failing). With the change, it and the existing audit suites pass: 132/132 across 5 files.

## Changed behaviour (exactly)

**`lib/scoped-braces-exception.mjs`:**
- `validateOfficialRelease(registry)` is the existing registry checks, extracted unchanged. Those checks are: `latest` is 3.0.3, the version list is exactly the pinned one, and integrity and tarball are unchanged.
- `validateWithdrawnAudit(run)` requires a complete, valid report with a consistent process status. **No finding of any level** is allowed: an empty graph and total = 0.
- `classifyFullAudit(run)` returns:
  - `"active"`: the unchanged scoped graph;
  - `"withdrawn"`: **only** when the scoped validation fails with *known advisory disappeared* **and** the report is completely clean.

  Every other failure is re-thrown.
- `validateWithdrawnDisposition(run, installed)`: the clean audit, plus every installed braces copy is the pinned 3.0.3.
- `validateWithdrawnOfficialEvidence(advisory, matching, registry, now)` requires all of the following:
  - an explicit verification clock `now`. The verifier passes `clock()`, taken after the official lookups; it is injectable for tests;
  - the **same** GHSA, CVE, API url, page and identifiers;
  - `withdrawn_at`, `published_at` and `updated_at` are valid instants;
  - **chronology:** `published_at ≤ withdrawn_at ≤ updated_at ≤ now + OFFICIAL_CLOCK_TOLERANCE_MS` (5 min), and `withdrawn_at` is after the reviewed `updated_at` (2026-10-02T22:36:34Z);
  - the affected package, range and `first_patched_version: null` are unchanged;
  - **the matching-advisory list for `braces@3.0.3`:**
    - it is a list with **at most one** entry, so duplicates and any other advisory are rejected;
    - that entry must be **complete and identical** to the directly fetched withdrawn record on every field in `MATCHING_ENTRY_FIELDS`: `ghsa_id`, `cve_id`, `url`, `html_url`, `type`, `severity`, `identifiers`, `vulnerabilities`, `published_at`, `updated_at` and `withdrawn_at`;
    - a mismatch names the field;
    - the list is **not required to be empty**, because GitHub's `affects=braces@3.0.3` query still returns the withdrawn advisory;
    - an empty list passes only together with the complete direct withdrawn record and the complete clean full and production audits;
  - the official release is unchanged.

**`scripts/verify-braces-exception.mjs`, `verifyBracesException`:**
- It classifies the full audit and always validates the production audit, which must be zero findings.
- It always runs `inspectInstalledBraces`, which covers:
  - the pinned local tarball and its integrity;
  - the patch and provenance hashes;
  - the vendor file set;
  - every installed copy, including shadow copies;
  - consumer resolution;
  - runtime and dev-only placement.
- It always checks lock-graph totals.
- **Same unchanged installation:** `ci-audit.mjs` (and the standalone verifier) take `snapshotInstallation()` **before** either audit runs. `verifyBracesException` requires `installedTreeSha256`, `lockSha256` and `packageSha256` of its own inspection to equal that snapshot. Otherwise it rejects with `installation changed between the audits and their verification`, before any official lookup. A missing snapshot is also rejected. The audit evidence therefore describes the exact installation that the following build and runtime verification use. `npm ci` runs once, before the audit, in the same job.
- It **always fetches** the three official documents and validates them for the mode.
- The proof format is `aqlan-braces-advisory-withdrawn-v1` (mode `withdrawn`) or the unchanged `aqlan-scoped-braces-exception-v1`.
- Test-only dependency injection is added for the fetcher and the inspector; the defaults are the real ones.

**`scripts/ci-audit.mjs`:**
- The full audit is accepted through `classifyFullAudit`, where it used `validateScopedAudit`.
- The success messages state which lifecycle state passed.
- The CLI explicitly accepts **only** a proof with `mode` `active` or `withdrawn`. It must also carry the advisory, CVE, package, version and counts. A withdrawn proof additionally needs `official.withdrawnAt` and `counts.total` 0. A missing or unknown mode, or a malformed required field, is rejected (`BRACES_EXCEPTION_REJECTED`, exit 1). A non-active value is never treated as withdrawn. Verifier errors still propagate to exit 1.
- **Defect in 229a39f6, fixed:** the CLI treated every non-active proof as withdrawn. The unchanged `ci-audit-runner` mock proof (no `mode`) therefore crashed into exit 1, which caused hosted run 40003309562 to fail at "Unit tests". The audit, build and runtime proof were skipped there, so that run is neither an audit rejection nor a live verification. The active fixture now states `mode: "active"` explicitly; no assertion was weakened.
- The retry, threshold and failure behaviour is unchanged.

**Unchanged:**
- the gate itself, which is not removed and has no unconditional success;
- the pinned local braces tarball, patch and integrity assertions;
- installed-copy, consumer and runtime checks;
- `verify-braces-runtime.mjs`;
- the workflow, `package.json`, lockfile and Dockerfile;
- every other dependency finding, which stays fail-closed.

## Regression cases (`__tests__/braces-advisory-withdrawal.test.mjs`, 79; plus `__tests__/ci-audit-runner.test.ts`: a withdrawn-proof success, 8 fail-closed proof-shape cases, and a snapshot-ordering assertion)

The synthetic official payload uses the independently verified live values: `withdrawn_at` 2026-10-23T12:53:02Z, `updated_at` 12:53:05Z.

- **Verified withdrawal plus a complete clean audit** on a synthetic installed tree passes. The patched copy is re-verified, all 3 official lookups are made, and the proof is written.
- **Unavailable registry or advisory service:**
  - a network failure, a 503 or a non-JSON official response is rejected;
  - a missing audit response, a registry error payload, a spawn error or a signal is rejected;
  - an official lookup failure inside verification is rejected.
- **Malformed payloads:**
  - incomplete or contradictory audit reports, and clean reports with a failing status;
  - a malformed or out-of-range withdrawal or update time;
  - changed identity, identifiers, package, range or patched version;
  - non-list, missing or malformed matching results;
  - a missing release document.
- **Contradictory counts, status or partial graphs:**
  - a claimed zero summary over a non-empty graph;
  - a moderate finding with a passing status;
  - a partial graph node;
  - a missing graph with zero counters;
  - missing dependency counters.
- **Unexpected findings or severity:** an info, low, moderate, high or critical finding on any package; a finding in the production audit; another advisory, active or withdrawn; this same advisory still active.
- **Patch, integrity and provenance drift:**
  - the patch file, the local archive integrity and the installed source files;
  - an unexpected installed braces copy;
  - a **missing installed copy** (`required installed package missing: node_modules/braces`);
  - an installation changed after the audits ran, or no pre-audit snapshot;
  - official registry versions, latest tag, integrity and tarball;
  - lock-graph total mismatch.

  Drift is rejected **before** any official lookup.

- **Official evidence consistency:**
  - **The direct record:**
    - an update before the withdrawal;
    - publication after the withdrawal;
    - a missing publication time;
    - an update beyond the clock tolerance (with the exact tolerance edge accepted);
    - a missing or NaN clock;
    - a changed API url.
  - **The matching list:**
    - a partial entry (identity plus withdrawal only);
    - a duplicate complete entry;
    - the withdrawn entry next to another advisory;
    - an entry differing in update time, identifiers, affected range or severity;
    - a complete entry that is still active;
    - a non-object entry.
  - **Unavailable services:** the matching-advisory service and the npm registry, each inside full verification.
- **No silent re-allowance:**
  - if braces is reported again, the audit classifies as `active`;
  - that path still demands live proof that the advisory is **not** withdrawn and has the reviewed `updated_at`;
  - so neither a withdrawn record nor a republished, re-updated advisory passes without a fresh review.
- **Runner CLI:**
  - the installation snapshot is taken before the first audit subprocess and handed to the verifier;
  - a withdrawn-mode proof is reported as such;
  - a proof without a known mode exits 1.

## Remaining notes

- **Independently verified:** the official API values (`withdrawn_at` 2026-10-23T12:53:02Z, `updated_at` 12:53:05Z, npm `latest` still 3.0.3 with the unchanged tarball and integrity) were independently verified on #442. They could not be fetched from this sandbox. Hosted CI performs the live lookup on every run. If GitHub's live payload differs from the reviewed shape in any checked field, the gate stays closed and reports exactly which field. It never passes silently.
- **Not changed:** the local patched vendor source and its nesting, cycle and compatibility regression tests (`braces-security-patch`, `braces-packaging`, `braces-provenance`) are unchanged and still pass.
- **Not bound:** `verify-braces-runtime.mjs` (also run in the Dockerfile without an audit) is unchanged. It records its own `lockSha256` and `packageSha256`, which can be compared with `exception-proof.json`; the two are not cross-checked automatically.
- **Kept, not retired:** the pinned patched local braces copy and its runtime and dev-only protections are kept unchanged. Retiring them would be a separate, reviewed change.
