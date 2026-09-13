# Repository Governance and Release Safety

This document records the governance audit performed on 2026-09-14 and the policy applied to `Aqlanf10/aqlan-center-mini`. The scope is repository and release governance only. Product behavior, capacity and scheduling code, appointment services and APIs, Settings code, AI booking tools, and Phase 4 migrations are outside this policy change.

## Baseline before hardening

The audit found the following repository state before any settings were changed:

- The default branch was `main` at commit `29b63a5f88d511529ce5efea0b465f37d59b0299`.
- `main` had no branch protection, required checks, pull-request rule, force-push restriction, deletion restriction, conversation-resolution rule, or administrator enforcement.
- The repository had no rulesets.
- The only GitHub Actions workflow was `.github/workflows/ci.yml`. It runs for pull requests into `main`, pushes to `main`, `feat/**`, and `hardening/**`, and manual dispatches.
- The real CI check emitted by GitHub Actions was `Typecheck, Lint, Test, Postgres, Audit, Build`, from GitHub Actions application ID `15368`. The check was successful on the audited `main` head and on PR #34.
- Merge commits, squash merges, and rebase merges were all enabled. Automatic merge was disabled, and merged branches were not automatically deleted.
- The latest first-parent history consistently used merge commits for PR traceability. The newest 22 audited first-parent commits were merge commits, covering PRs #12 through #21 and #23 through #34; PR #22 was not present in that first-parent range. The next older first-parent commit, `3774a4a`, was a direct commit.
- There was one direct collaborator, repository owner `Aqlanf10`, with administrator permission. A required independent approval would therefore prevent the owner from merging their own work.
- There was no `CODEOWNERS` file, Dependabot configuration file, or Renovate configuration.
- Secret scanning and secret-scanning push protection were enabled. Dependabot alerts and automated security updates were disabled. CI already runs the dependency audit included in its check.
- The workflow did not reference any `${{ secrets.* }}` values. The audit inspected names only and did not access repository or Railway secret values.
- There were no GitHub releases or Git tags, so the repository had no formal tag-based release strategy.
- Railway's GitHub application created production deployments from `main`. The audited merge of PR #34 completed at 19:18:35 UTC, the `main` CI run was created at 19:18:37 UTC, and Railway reported deployment `in_progress` at 19:18:40 UTC. Railway and post-merge CI therefore started independently. The deployment later succeeded.

## Active policy

The repository uses classic `main` branch protection as the single enforcement source. A second ruleset is intentionally not layered on top because duplicate policies are harder to audit and can drift.

| Control | Enforced setting |
| --- | --- |
| Change path | A pull request is required before a change can reach `main`. |
| CI | `Typecheck, Lint, Test, Postgres, Audit, Build` is required and is bound to GitHub Actions application ID `15368`. |
| Freshness | Strict status checks require the PR branch to be up to date with `main`. Repository update-branch support is enabled. |
| Review conversations | Every review conversation must be resolved before merge. |
| Approval count | Zero independent approvals are required because the repository has one owner/developer and GitHub does not count self-approval. The owner must still review and explicitly merge the PR after green CI. |
| Stale reviews | Existing reviews are dismissed when new commits are pushed. |
| Administrator bypass | Protection is enforced for administrators. No actor bypass was configured. |
| Direct and force pushes | Direct pushes to `main` are blocked by the pull-request rule. Force pushes are disabled. |
| Branch deletion | Deleting `main` is disabled. Merged feature branches are not deleted automatically. |
| Merge method | Merge commit is the only enabled merge method. Squash and rebase merges are disabled. |
| Automatic merge | Disabled. |

Dependabot alerts and automated security updates are enabled. Secret scanning and secret-scanning push protection remain enabled.

## Working rules for people and agents

1. Use one feature branch per agent and task. Never work directly on `main`.
2. Fetch the latest `origin/main` before creating the feature branch. Base the branch on that fetched commit.
3. Keep each branch within its assigned scope. Coordinate before editing a file owned by another active task.
4. Never force-push. Add corrective commits when a published branch needs a fix.
5. Preserve migration history. Never edit or reorder a migration that has shipped; add a new forward migration.
6. Open a pull request and wait for `Typecheck, Lint, Test, Postgres, Audit, Build` to succeed before asking the owner to review.
7. Resolve every review thread and update the branch from `main` when GitHub reports it behind.
8. Do not enable automatic merge. An agent stops after opening the PR unless the owner explicitly authorizes that agent to merge it.
9. Use merge commits so the PR boundary and source branch remain visible in first-parent history.

## Branch cleanup audit

No branch was deleted during this work. Deletion always requires owner approval.

### SAFE TO DELETE

The following remote branches had a merged PR, were fully contained in `main`, and had zero commits ahead of `main` at audit time:

- `codex/release-fixes`
- `copilot/audit-data-integrity-and-remediation`
- `docs/phase-0-clinic-operations-baseline`
- `feat/expected-arrivals-day-screen`
- `feat/open-past-appointments`
- `feat/phase-1b-settings-ui`
- `feat/settings-core-platform`
- `feat/settings-search-arabic`
- `feat/single-clinic-timezone`
- `fix/backup-volume-entrypoint-v2`
- `fix/settings-patch-version-contract`
- `hardening/ci-operational-verification`
- `hardening/production-readiness-p1`
- `hardening/production-readiness-p2`
- `hardening/production-readiness-v2`
- `hotfix/login-limit-sql`
- `ops/final-production-readiness`
- `ops/production-backup-one-shot`
- `ops/production-baseline-verification`
- `ops/production-parity-tls`
- `ops/production-schema-gate`
- `ops/production-schema-manifest`

### KEEP FOR NOW

- `feat/appointment-lifecycle` was fully merged through PR #33, but it belongs to the current appointment work area.
- `feat/capacity-engine` was fully merged through PR #34, but it belongs to the active capacity work area.

These two branches are technically contained in `main`; retaining them temporarily avoids disrupting concurrent Phase 4 work that may still refer to their names.

### UNKNOWN

- `hardening/production-readiness` had no associated PR and contained five commits not reachable from `main`. Review those five commits before deciding whether to archive, replace, or delete the branch.

## Production release path

The repository now enforces this path into the release branch:

```text
feature branch
  -> pull request
  -> required PR CI succeeds on a branch up to date with main
  -> owner reviews and creates a merge commit
  -> main
```

After the merge, the observed production path is currently parallel:

```text
main push
  +-> GitHub Actions post-merge CI
  `-> Railway automatic production deployment
```

`railway.json` defines the Dockerfile build, `/api/health` check, restart policy, and replica count. It does not express a GitHub CI gate. Because Railway began the audited deployment while the post-merge workflow was starting, a failed post-merge CI run could still deploy. Strict PR CI greatly reduces that risk but does not remove the race.

The remaining owner action is to open the linked production service in Railway, go to its service settings, and enable **Wait for CI**. Railway documents that deployments then enter a waiting state while GitHub workflows run, proceed only after all workflows succeed, and are skipped if a workflow fails. The existing workflow already satisfies Railway's requirement to run on pushes to `main`. This setting was not changed because production configuration changes require explicit owner authorization.

## Release and security maintenance

- Use the merge commit SHA as the production revision until a tag strategy is adopted.
- When formal releases are needed, create annotated `vMAJOR.MINOR.PATCH` tags from verified `main` merge commits and publish matching GitHub releases. Do not tag feature branches.
- Keep GitHub Actions dependency audit, Dependabot alerts, automated security updates, secret scanning, and push protection enabled.
- Review Dependabot pull requests through the same protected PR and CI path.
- Do not print, copy, or audit secret values. Repository workflows should reference only named GitHub secrets when a future deployment workflow needs credentials.

## Safe validation procedure

Validate governance through GitHub's branch-protection and repository APIs, a normal feature-branch push, and the CI result on its pull request. Do not test protection by attempting an intentional direct push or by breaking `main`.
