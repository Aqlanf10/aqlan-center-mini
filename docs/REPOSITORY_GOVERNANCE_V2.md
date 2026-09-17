# Repository Governance and Release Safety v2

**Repository:** `Aqlanf10/aqlan-center-mini`
**Audited baseline:** `c9e734ca02145cb5f45415ba8f0bedf8140307d4` (`main`, merge of PR #42)
**Audit date:** 2026-09-17
**Methodology:** AUDIT → VERIFY → DOCUMENT → TEST
**Predecessor:** PR #35 "Document repository governance and release safety" — **closed without merge and preserved as historical evidence only.**

> **Supersession statement.** PR #35 was closed without merge and is historical only.
> This document supersedes its intended governance role. The old PR was based on the
> pre-TD-00 baseline `29b63a5` (2026-09-14, PR #34 era) and its governance content is
> historical/stale in places; its useful policy concepts were re-audited from scratch
> and re-verified against the current repository state before being restated here.
> Nothing was copied blindly, and no branch was deleted.

---

## 1. Purpose and authority

This document is the single authoritative statement of repository governance, release
safety, and working rules for both humans and AI agents operating on
`Aqlanf10/aqlan-center-mini`. It records what is actually **verified** about the
repository's protection, merge policy, CI, and deployment path at the audited baseline,
and it defines the authorization classes that govern every change — especially changes
that can reach production or financial data.

Authority chain:

- `docs/CONSTITUTION.md` and `docs/BLUEPRINT.md` define the architectural invariants
  of the clinic system itself (product-level).
- This document (`docs/REPOSITORY_GOVERNANCE_V2.md`) defines repository-level and
  release-level governance (process-level).
- `docs/TECHNICAL_DEBT_MASTER_REGISTER.md`,
  `docs/SOURCE_OF_TRUTH_OWNERSHIP_MAP.md`, and
  `docs/TECHNICAL_DEBT_EXECUTION_PLAN.md` (landed on `main` with PR #42) define the
  technical-debt program and its owner-fixed execution sequence.

Where any older document conflicts with this one on repository governance, this
document governs.

## 2. Audited baseline

All facts in sections 3–6 were freshly verified on 2026-09-17 against:

| Item | Verified state |
|---|---|
| `main` HEAD | `c9e734ca02145cb5f45415ba8f0bedf8140307d4` (merge commit of PR #42) |
| PR #42 | Closed as **merged** at 2026-09-16T23:52:15Z; post-merge CI on `main` green |
| TD-00 documents on `main` | Present: `TECHNICAL_DEBT_MASTER_REGISTER.md`, `SOURCE_OF_TRUTH_OWNERSHIP_MAP.md`, `TECHNICAL_DEBT_EXECUTION_PLAN.md`, plus the supersession banner on `TECHNICAL_DEBT_REPORT.md` |
| PR #35 | Open at audit start → **closed without merge** during this audit (comment `5706365489`); branch `docs/repository-governance` preserved, no history modified |
| Open PRs after this audit | Only the governance-v2 PR introduced by this task |
| Tags / releases | **0 tags, 0 releases** (unchanged since the PR #35-era audit; first tag is scheduled by TD-10) |
| Collaborators | Exactly one: `Aqlanf10` (owner; admin/maintain/push/triage/pull — full permissions) |
| Rulesets | **None** (classic branch protection is the single enforcement source; intentionally no layered rulesets) |
| `CODEOWNERS` / `dependabot.yml` | Not present (no file-based code ownership or Dependabot config; repository-level Dependabot security updates are enabled — see §14) |

## 3. Current GitHub protection (`main`, classic branch protection)

Verified via the branch-protection API on 2026-09-17. This is the single enforcement
source; no rulesets are layered on top (duplicate policies are harder to audit and
drift).

| Control | Verified setting |
|---|---|
| Pull request required before merge | **Yes** — direct pushes to `main` are blocked by the PR rule |
| Required status check | **`Typecheck, Lint, Test, Postgres, Audit, Build`** — bound to GitHub Actions application ID `15368` |
| Strict / up-to-date requirement | **Enabled** — the PR branch must be up to date with `main` before merging |
| Administrator enforcement | **Enabled** — protection applies to administrators; no actor bypass configured |
| Review conversation resolution | **Enabled** — every review conversation must be resolved before merge |
| Required approving review count | **0** — single-owner repository; GitHub does not count self-approval. The owner still reviews and explicitly merges every PR after green CI |
| Stale-review dismissal | **Enabled** — reviews are dismissed when new commits are pushed |
| Last-push approval requirement | Disabled |
| Code-owner review requirement | Disabled (no `CODEOWNERS` file exists) |
| Required signatures | Disabled |
| Linear history | Not required (merge commits preserve PR boundaries in first-parent history) |
| Force pushes to `main` | **Disabled** |
| Deletion of `main` | **Disabled** |
| Branch lock / fork syncing / creation blocking | Disabled / Disabled / Disabled |

No API permission prevented verification of any item in this section; every value
above was read directly from the protection endpoint.

## 4. Merge policy

Verified repository merge settings:

| Setting | Value |
|---|---|
| Merge commits | **Enabled** (the only enabled method) |
| Squash merge | Disabled |
| Rebase merge | Disabled |
| Auto-merge | **Disabled** — nothing merges without an explicit owner action |
| Update-branch support | **Enabled** — a stale PR can be updated from `main` via the GitHub UI |
| Delete branch on merge | **Disabled** — merged branches are kept as historical evidence and deleted only with owner approval |

Policy consequence: the PR boundary and source branch remain visible in first-parent
history, which is the audit trail for "who merged what, when". PRs #40/#41/#42 all
landed as merge commits, consistent with this policy.

## 5. CI contract

One workflow exists: `.github/workflows/ci.yml` — single job
`quality` ("Typecheck, Lint, Test, Postgres, Audit, Build"), `ubuntu-latest`,
timeout 55 minutes, concurrency group `ci-${{ github.ref }}` with
cancel-in-progress.

**Triggers** (all classes listed):

- `pull_request` → `main` (REQUIRED for every change that can reach `main`)
- `push` → `main` (post-merge verification — REQUIRED), and `feat/**`, `hardening/**` (branch-push verification — NON-REQUIRED convenience)
- `workflow_dispatch` (MANUAL)

**Service container:** `postgres:18-alpine` (users `ci/ci`, databases
`aqlan_p1_test` + maintenance `postgres`). PostgreSQL **18** — the same major
version targeted for production.

**Environment:** Node **22** (with npm upgraded to v11 for the bulk advisory
endpoint), pinned `DATABASE_URL`/`TEST_DATABASE_URL` placeholders that prevent
accidental use of a real Railway URL, `SESSION_SECRET` CI placeholder,
`CLINIC_TIME_ZONE: Asia/Aden`.

**Steps in order, with obligation class** (single required check name covers them
all — the check is REQUIRED for merge; classification below distinguishes the
step's nature):

| # | Step | Command | Class |
|---|---|---|---|
| 1 | Checkout | `actions/checkout@v7` | — |
| 2 | Node setup | `actions/setup-node@v7`, node 22, npm cache | — |
| 3 | npm upgrade | `npm install -g npm@11` | CONDITIONAL prerequisite (audit endpoint fix) |
| 4 | Install | `npm ci` | — |
| 5 | Typecheck | `npm run typecheck` (`tsc --noEmit`) | REQUIRED |
| 6 | Lint | `npm run lint` (`eslint .`) | REQUIRED |
| 7 | Unit tests | `npm test` (`vitest run`, PGlite) | REQUIRED |
| 8 | PostgreSQL integration | `npm run test:postgres` (vitest postgres config) | REQUIRED |
| 9 | Schema contract on PG18 | `npm run schema:contract` + artifact upload | REQUIRED (provenance artifact) |
| 10 | Operational journeys | `npm run verify:ci` | REQUIRED |
| 11 | Baseline manifest generate + verify | `npm run db:baseline:manifest` / `:verify` + artifact | REQUIRED (immutable-0001 gate) |
| 12 | Dependency audit | `node --import tsx scripts/ci-audit.mjs` | REQUIRED (fails on confirmed moderate+ vulnerabilities; registry outages retried with loud warning) |
| 13 | Raw-body scanner | `npm run ci:scan:body` | REQUIRED (no raw `request.json()` in `app/api`) |
| 14 | Production build | `npm run build` | REQUIRED |
| 15 | HTTP security tests | `npm run test:security-http` (Playwright/Chromium against built app) | REQUIRED |
| 16 | Settings UI screenshots | artifact upload, `if: always()` | NON-REQUIRED (diagnostic artifact) |

**Journey registry** (`scripts/verify-ci-journeys.mjs`, freshly counted at this
baseline): **20 operational journeys** in 5 phases — phase 1: 7 PGlite journeys
(announcements, appointments, deletions, messages, reports, settings, workflow);
phase 2: 10 PostgreSQL journeys (audit, clinical, concurrency, documents, identity,
inventory, ortho, plans, portal, executive); phase 3: schema; phase 4: backup;
phase 5: ceph. A skipped journey is never counted as passed ("لا فشلَ صامت").

> **Recorded observation (for the owner, not corrected here):** the TD-00 master
> register's baseline snapshot records "18 operational verification journeys"; the
> registry at the same commit defines **20** journey entries. The fresh count in
> this document is the verified one; the register's snapshot figure should be
> reconciled in the next documentation pass of the TD series (TD-10 closes the
> register). No code or data was changed by this observation.

**Secrets usage:** the workflow references **no `${{ secrets.* }}` values at all**
(verified by inspection); CI credentials are placeholder-only. CI cannot touch
production from inside the workflow.

## 6. Release / deployment path (repository-side evidence)

```
feature branch (never main)
  → pull request into main
  → REQUIRED CI check "Typecheck, Lint, Test, Postgres, Audit, Build" (strict, up-to-date)
  → owner review (conversation threads resolved)
  → owner merges (merge commit; squash/rebase disabled; auto-merge disabled)
  → main (protected: no direct push, no force push, no deletion)
  → post-merge CI on main (same required check, push trigger)
  → Railway builds from main via Dockerfile (railway.json)
  → deploy with healthcheck /api/health (timeout 120s, restart ON_FAILURE, max 10 retries, 1 replica)
```

Repository-side evidence for the Railway link: `railway.json` (builder
`DOCKERFILE`, healthcheck path/timeout/restart policy), `Dockerfile` (multi-stage;
runner stage ships only `.next/standalone` + static assets).

**VERIFIED (GitHub-side evidence).** The audited baseline commit
`c9e734ca02145cb5f45415ba8f0bedf8140307d4` carries a **successful Railway web
deployment status** visible through the GitHub commit-status API: context
`aqlan-center-mini - web`, state `success`, description
`Success - web-production-23f82.up.railway.app`, recorded by `railway-app[bot]`
(the combined commit status for that SHA is `success`). This proves that the
audited `main` head was built and deployed by Railway and passed its deploy
gate. It proves nothing about Railway's internal configuration.

**NOT VERIFIED.** The following remain unverified and must not be asserted as
fact in any downstream document until the owner verifies them on the Railway
dashboard:

- the Railway **"Wait for CI" setting** — no claim is made that it is enabled;
- current Railway dashboard configuration;
- production environment variable values;
- full deployment history;
- production PostgreSQL major version (unless separately proven).

Post-merge GitHub CI and the Railway deployment are therefore to be treated as
**independent** pipelines until the owner verifies the Railway setting; this
matches the historical observation recorded in the PR #35-era audit
(merge 19:18:35Z → CI 19:18:37Z → Railway in_progress 19:18:40Z).

**Railway deployment is production.** Every merge to `main` is a production
release (see TD-REG-010; a staging environment is planned under TD-02 and the
owner-fixed sequence).

## 7. Branch and PR workflow

1. One task = one branch = one PR. Branch names describe the task
   (`docs/…`, `feat/…`, `fix/…`, `td/…`, `ops/…`, `hardening/…`).
2. Branches are always created from the **latest `origin/main`** (fetch first;
   never from a stale local checkout).
3. Never work directly on `main` — it is protected and direct pushes are blocked.
4. Never force-push (protection also forbids it on `main`; do not force-push
   published task branches either — add corrective commits).
5. Never enable auto-merge. An agent stops at an open PR unless the owner
   explicitly authorizes merge.
6. If a branch goes stale, update it from `main` (GitHub update-branch support is
   enabled; strict status checks require it before merge).
7. Resolve every review conversation before merge (protection enforces it).
8. Merged branches are **not** auto-deleted (setting disabled); deletion requires
   explicit owner approval. Historical branches are evidence.
9. Merge commits are the only merge method — keep first-parent history readable.

## 8. Agent rules (binding for all AI-agent work)

1. **Methodology:** AUDIT → REUSE → EXTEND → TEST → DOCUMENT. Reuse existing
   modules and tests before inventing new abstractions; justify anything new.
2. One task, one branch, one PR — branched from latest `origin/main`.
3. Never work directly on `main`; never force-push; never auto-merge.
4. Wait for the required CI check to be green before asking the owner to review.
5. Owner review before merge, always; resolve all review threads first.
6. Update from `main` when the branch is behind (strict checks will demand it).
7. Preserve shipped migrations (see §9).
8. No production changes unless the task explicitly authorizes them
   (see §12 authorization classes).
9. **No production database writes as part of audit/review work** — audits are
   read-only against production; anything stronger needs an explicit task
   authorization with an abort point.
10. No secrets in logs, docs, PR bodies, comments, screenshots, or test artifacts
    (see §14).
11. Stop at an open PR unless the owner explicitly authorizes merge.
12. End-of-task reporting states exactly what was and was not changed.

## 9. Migration governance

Post-TD-00 rules (aligned with `docs/TECHNICAL_DEBT_EXECUTION_PLAN.md`):

1. **Delivered migrations are immutable.** `migrations/0001..0011` must never be
   edited, reordered, or rewritten. The CI baseline-manifest verify step enforces
   this mechanically: a modified `0001` fails the build.
2. **New schema changes require a new forward migration** — added at the end of the
   chain with its own number, checksum-registered in `schema_migrations`.
3. **TD-01A/TD-01B govern migration-system adoption.** TD-01A proves the numbered
   migration chain on **staging only** (deployment/staging/fresh-db/restored-db/
   equivalence proof). TD-01B performs the **read-only production preflight**, then
   the owner-approved adoption, then the staged `ensureSchema` retirement.
4. **`ensureSchema` remains transitional technical debt** until TD-01B closes it.
   It is currently the only schema mechanism the deployment image can execute
   (proven from the `Dockerfile`); repository documentation describes it as the
   active production schema owner (documented historical state — see TD-REG-001
   evidence classes A/B/C).
5. **No governance document may imply that numbered migrations already own
   production** unless TD-01B later proves and adopts that state. Until then,
   production migration adoption state is expressed exactly as:
   *"not independently proven; the current deployment image cannot execute the
   numbered migration runner."*
6. Seed data is not a migration: seeds (staff defaults, starter services, expense
   categories) live in `ensureSchema` today and move to an explicit provisioning
   path under TD-01A scope (e) — with `SKIP_SEED` restore semantics preserved.

## 10. Technical-debt governance

The authoritative technical-debt documents (landed on `main` with PR #42) are:

- `docs/TECHNICAL_DEBT_MASTER_REGISTER.md` — 24 evidence-based entries
  (P0:1 / P1:3 / P2:8 / P3:12), TD-REG-001 evidence split into proven (A) /
  documented (B) / unverified-pending-preflight (C).
- `docs/SOURCE_OF_TRUTH_OWNERSHIP_MAP.md` — 13 operational domains, each with a
  canonical owner and competing implementations.
- `docs/TECHNICAL_DEBT_EXECUTION_PLAN.md` — phase plan under the **owner-fixed
  sequence**:

```
PR #42 merge (DONE 2026-09-16)
→ refresh/resolve PR #35 governance (this document; PR #35 closed without merge)
→ TD-05  (base-currency truth)
→ TD-02  (environment parity)
→ TD-08A (pre-adoption backup/restore proof)
→ TD-01A (schema unification — STAGING ONLY)
→ TD-01B (production read-only preflight + owner-approved adoption + ensureSchema retirement staging)
→ TD-04  (authorization matrix)
→ TD-03  (domain consolidation)
→ TD-06  (mutation/audit contracts)
→ TD-07  (code hygiene / dead code / warning closure)
→ TD-08B (final backup proof)
→ TD-09  (full-day multi-role E2E)
→ TD-10  (closure gate, release tag)
```

Rules:

1. No TD phase starts without explicit owner approval of that phase.
2. Each phase is a small, independently reviewable PR on its own `td/NN-<slug>`
   branch, with rollback strategy, required tests, and a DOCUMENT step that
   updates the register.
3. Production-touching phases (TD-01B, TD-08A, TD-08B) additionally require a
   staging rehearsal, a verified backup as the abort point, and explicit owner
   approval; TD-01B requires the read-only preflight report first.
4. New debt discovered during any phase is **recorded as new register entries**,
   never fixed silently inside an unrelated phase.

## 11. Financial safety invariants

Restated from the finance constitution invariants (see also
`docs/finance_system_governance.md`, `docs/CONSTITUTION.md`):

1. **YER / SAR / USD remain independent currencies.** No silent cross-currency
   aggregation anywhere.
2. **Append-only financial history.** Payments, expenses, invoices and ledger
   rows are never updated or deleted in place; the tables are guarded by
   migration 0005 triggers mirrored in `ensureSchema`.
3. **Correction through reversal/adjustment**, never through editing history.
4. **Exchange-rate snapshot at transaction time.** A payment keeps the rate of its
   day; updating the rate does not retroactively change past reports.
5. **Base-currency source of truth:** the constitutional constant
   `CLINIC_BASE_CURRENCY = "YER"` (`lib/money.ts`) — a single owner since TD-05.
   The `finance.base_currency` setting is retained only as a locked compatibility
   key: `systemLocked` in `lib/settings-definitions.ts` (writes rejected
   server-side even for admin; UI shows "محكوم بالنظام"; zero runtime readers).
   TD-REG-004 closed by TD-05 (2026-09-17).
6. **Patient financial-agreement currency (TD-05):** treatment plans and
   invoices carry an explicit per-agreement currency — YER / SAR / USD chosen
   by authorized staff at creation, stored, and returned on readback; it flows
   to installments, invoices, payments, statements and per-currency balances.
   A payment settles the bucket of its invoice's currency (same-currency at
   face value; a foreign-currency payment against a base-currency invoice keeps
   the documented snapshot-equivalent contract). Cross-currency settlement
   against a non-base invoice fails clearly — never a silent conversion.
   The clinic base currency (YER) is NOT permission to re-denominate patient
   agreements; patient account currency is independent of the clinic base.

## 12. Production-change authorization classes

Every task and PR is classified. Rigor increases with the class:

| Class | Description | Requirements |
|---|---|---|
| **A** | Documentation-only (docs, comments, PR bodies) | Normal review; no runtime effect |
| **B** | Application code (product behavior) | Full CI; owner review; rollback = revert |
| **C** | Schema/migration | New forward migration only; CI manifest gates; TD-plan sequencing |
| **D** | Financial logic | B + financial-invariant regression suites; explicit owner approval |
| **E** | Production configuration (Railway, env, deploy) | Explicit owner approval; before/after evidence; rollback/abort point defined before start |
| **F** | Production database/data | Explicit owner approval; verified backup first; abort point; evidence before and after |

For classes **D / E / F** additionally:

- explicit owner approval **for this change** — no implicit authorization carried
  over from any earlier, unrelated approval;
- a rollback/abort point agreed **before** the change starts;
- evidence captured before and after (reports, diffs, logs).

Class-F work must never occur "as part of" an audit or review task (see §8.9).

## 13. Backup / recovery governance

Status vocabulary (these words are **not interchangeable**):

- **implemented** — code exists and is covered by tests;
- **configured** — concrete environment values exist (e.g. a production schedule);
- **connected** — a live path to real infrastructure is proven;
- **enabled** — the mechanism is active in production;
- **tested** — a restore has been **proven** end-to-end.

**A backup feature is not production-certified until restore has been proven.**

Current repository-side facts: the backup subsystem is broad (15+ modules,
`docs/PRODUCTION_BACKUP_GATE.md` documents 13 files / 101 tests on isolated PG18;
journeys phase 4 runs `verify-backup`). The production-side drill dates, RPO/RTO
observations, and the pre-adoption proof are governed by:

- **TD-08A** — pre-adoption backup/restore proof (runs before TD-01A; produces the
  abort-point backup and the restore-drill report);
- **TD-08B** — final backup proof (post-unification re-proof).

Until TD-08A lands, no statement in any document may claim production backup
certification beyond what is proven.

## 14. Secrets and sensitive data

Verified repository state (2026-09-17):

| Control | State |
|---|---|
| Secret scanning | **Enabled** |
| Secret scanning push protection | **Enabled** |
| Secret scanning non-provider patterns | Disabled |
| Secret scanning validity checks | Disabled |
| Dependabot security updates | **Enabled** |
| Dependabot version updates config (`dependabot.yml`) | Not present (no automated dependency PRs) |
| CI workflow secrets usage | **None** — no `${{ secrets.* }}` references; placeholder env only |
| Committed secrets | None known (push protection active; prior audits found none) |

Rules:

1. Never place tokens, passwords, connection strings, or session secrets in
   code, docs, PR bodies, comments, commit messages, logs, screenshots, or test
   artifacts. Redact before pasting.
2. CI placeholders exist precisely so a workflow cannot accidentally reach a real
   database; keep that property.
3. A leaked credential is revoked first, then cleaned from history by the owner —
   history edits are an owner decision (classes E/F).

## 15. Review / merge checklist (owner-facing)

Before clicking merge, the owner verifies:

- [ ] Required check `Typecheck, Lint, Test, Postgres, Audit, Build` is green on the PR head
- [ ] Branch is up to date with `main` (strict mode enforces; confirm anyway)
- [ ] All review conversations are resolved (protection enforces)
- [ ] Diff matches the task's declared scope — no surprise files
- [ ] Change class (§12) is known; D/E/F have approval, abort point, and evidence plan
- [ ] Migrations, if any, are new forward numbers only (§9)
- [ ] No secrets in the diff (§14)
- [ ] For docs-only PRs: no product/migration/Railway files touched

## 16. External settings: verified vs. unverified

One external fact was verified through GitHub during this audit (restated from
§6): the audited baseline commit `c9e734ca…` carries a successful Railway web
deployment commit status (`Success - web-production-23f82.up.railway.app`,
recorded by `railway-app[bot]`). Everything else that lives outside the
repository remains **not verified** by this audit and must not be asserted as
fact in any downstream document until the owner verifies it on the respective
dashboard:

| Setting | State | How to verify |
|---|---|---|
| Railway deployment status of the audited baseline commit `c9e734ca…` | **VERIFIED** — commit status `Success - web-production-23f82.up.railway.app` (context `aqlan-center-mini - web`, creator `railway-app[bot]`, combined status `success`) | Already verified via the GitHub commit-status API |
| Railway "Wait for CI" deployment gate | **NOT VERIFIED** — must not be claimed as enabled | Railway dashboard → service → deploy settings |
| Railway environment variable values (production `DATABASE_URL`, `SESSION_SECRET`, etc.) | NOT VERIFIED (out of scope by policy) | Railway dashboard; never paste values into docs |
| Railway current dashboard configuration / full deployment history beyond the audited commit | NOT VERIFIED | Railway dashboard |
| Railway PostgreSQL version in production | NOT VERIFIED (CI targets PG18; production major assumed but not proven by repository evidence) | Railway dashboard or `SELECT version();` via an authorized read-only path |
| GitHub organization-level policies (if any apply) | NOT VERIFIED (no organization-level access attempted) | GitHub org settings |

Repository-side settings that **were** fully verified are recorded in §3–§5.

## 17. Superseded governance documents

| Document / PR | Status |
|---|---|
| PR #35 "Document repository governance and release safety" (branch `docs/repository-governance`, head `a275c37`) | **Closed without merge 2026-09-17; preserved as historical evidence.** Based on pre-TD-00 baseline `29b63a5` (2026-09-14). Its audit of then-current protection matches today's verified settings (§3–§4), but its surrounding context (open TD-00, no migration-governance rules, pre-split TD plan) is historical. |
| `docs/REPOSITORY_GOVERNANCE.md` | Exists only on the preserved `docs/repository-governance` branch (never on `main`); historical evidence only. |
| `docs/TECHNICAL_DEBT_REPORT.md` (v1.0.0) | Superseded by the TD-00 master register (banner already on file). |
| **This document** | Current authoritative governance: `docs/REPOSITORY_GOVERNANCE_V2.md`. |

## 18. Future governance maintenance

1. This document is re-audited (not merely edited) whenever a protection setting,
   merge setting, CI trigger/check, or the deployment path changes materially.
2. Each TD phase that changes governance-relevant state (TD-01B adoption, TD-02
   staging environment, TD-10 release tagging) includes a DOCUMENT step updating
   this file in the same PR.
3. The count discrepancy noted in §5 (register snapshot "18" vs registry "20"
   journeys) is reconciled at the TD-10 register-closure step.
4. When the first release tag exists (TD-10), §2 and §16 gain a "last verified at
   tag" column.
5. Ownership of this document: repository owner (`Aqlanf10`), with agent-prepared
   refresh PRs allowed under class A rules.
