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
- `validateWithdrawnOfficialEvidence(advisory, matching, registry)` requires all of the following:
  - the **same** GHSA, CVE, page and identifiers;
  - `withdrawn_at` is a valid instant after the reviewed `updated_at` (2026-10-02T22:36:34Z), and not in the future;
  - `updated_at` is valid;
  - the affected package, range and `first_patched_version: null` are unchanged;
  - the matching-advisory list for `braces@3.0.3` contains **nothing but this same advisory withdrawn**;
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
- It **always fetches** the three official documents and validates them for the mode.
- The proof format is `aqlan-braces-advisory-withdrawn-v1` (mode `withdrawn`) or the unchanged `aqlan-scoped-braces-exception-v1`.
- Test-only dependency injection is added for the fetcher and the inspector; the defaults are the real ones.

**`scripts/ci-audit.mjs`:**
- The full audit is accepted through `classifyFullAudit`, where it used `validateScopedAudit`.
- The success messages state which lifecycle state passed.
- The retry, threshold and failure behaviour is unchanged.

**Unchanged:**
- the gate itself, which is not removed and has no unconditional success;
- the pinned local braces tarball, patch and integrity assertions;
- installed-copy, consumer and runtime checks;
- `verify-braces-runtime.mjs`;
- the workflow, `package.json`, lockfile and Dockerfile;
- every other dependency finding, which stays fail-closed.

## Regression cases (`__tests__/braces-advisory-withdrawal.test.mjs`, 50)

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
- **Unexpected findings or severity:** a low, moderate, high or critical finding on any package; a finding in the production audit; another advisory, active or withdrawn; this same advisory still active.
- **Patch, integrity and provenance drift:**
  - the patch file, the local archive integrity and the installed source files;
  - an unexpected installed braces copy;
  - official registry versions, latest tag, integrity and tarball;
  - lock-graph total mismatch.

  Drift is rejected **before** any official lookup.

## Remaining notes

- **Unknown until hosted CI runs:** the exact live official values, `withdrawn_at` and `updated_at`, could not be fetched from this sandbox; the HTML page confirms the withdrawal. If GitHub's live payload differs from the reviewed shape in any checked field, the gate stays closed and reports exactly which field. It never passes silently.
- **Kept, not retired:** the pinned patched local braces copy and its runtime and dev-only protections are kept unchanged. Retiring them would be a separate, reviewed change.
