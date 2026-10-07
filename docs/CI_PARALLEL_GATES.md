# Parallel CI with complete release evidence

CI keeps the exact release check name `Typecheck, Lint, Test, Postgres, Audit, Build`.
That check belongs only to the final `quality` job. It directly needs four independent
jobs and evaluates with `always()`. Every lane must finish with literal `success`.
A skipped, cancelled, missing, timed-out or failed lane cannot become a green aggregate.
Force-cancelling GitHub's final job may prevent it from executing; the absence of a
successful check is a release blocker, never success.

## Work and isolation

- `security_early`: unchanged raw full/production audit and fresh official evidence.
- `static_quality`: DAG/fault tests, typecheck, lint, money guard, unchanged serial unit suite, body-parser scan.
- `postgres_schema_journeys`: unchanged PostgreSQL suite, schema generation/compare/restore,
  ownership characterization, operational journeys and baseline manifest generation/comparison.
- `build_http`: a second unchanged audit against this job's actual installed dependencies,
  production build, preflight build/help smoke, runtime-absence proof, Chromium/OS and
  Poppler installation, unchanged real HTTP suite and exact synthetic UI artifacts.

Each work job gets an exact `github.sha` checkout, Node 22, npm 11, `npm ci` and the
existing environment verifier. Pull requests test their immutable event merge commit,
while receipts retain both source-head and base identity. No branch-ref fallback exists.
PostgreSQL and HTTP use distinct hosted runners and distinct PostgreSQL 18 service
containers. Their IDs are compared by the final gate. All existing loopback database
URLs, synthetic session secret, Asia/Aden timezone, step-scoped disposable opt-ins,
maintenance-database overrides, serial Vitest settings and journey ordering remain.
The 55-minute timeout remains. No app/data/build cache is introduced.

## Executable workflow contract

`.github/ci/workflow.json` is the parsed canonical job graph. Its deterministic rendering
must exactly equal `.github/workflows/ci.yml`; unparsed YAML edits fail the source gate.
`.github/ci/contract.json` separately inventories every original command, action,
condition, environment and artifact. `workflow.py` checks the complete DAG, its
bootstrap and ordering constraints, original-step preservation, final semantics,
exact artifact allowlists and unchanged security/verifier/test-configuration hashes.

To make a reviewed CI change, edit the graph and the explicitly affected contract,
then run `python3 .github/ci/workflow.py --render`. Run the contract/fault tests and
all existing suites on the resulting exact source tree. Do not update protected
hashes merely to silence a failure; changes to security policy need independent review.
The local `verify:full` sequence stays serial. Its command set and ordering are still
tested; CI parity now checks a valid per-lane dependency graph rather than a single
global textual order.

## Evidence and reruns

The lane recorder binds event, source head/base, exact checkout and tree, workflow
identity/blob, package/lock digests, run/attempt, tool versions, hostname and service ID.
It checks a clean tracked source tree before and after work and rejects stale initial
build/audit/browser outputs or `.env.local`. Every required step's `outcome` and
`conclusion` must be `success`, including uploaders. No `continue-on-error` is allowed.

Original upload conditions and diagnostic missing-file policies remain. A successful
release additionally requires every real artifact family and each exact file member.
The final gate downloads exact immutable artifact IDs, checks current-run metadata,
head, attempt-bound names, uploader/server/ZIP digests, and exact member sets, sizes
and byte hashes. It rejects traversal, aliases, symlinks, duplicate members, corrupt
JSON or empty required evidence. No extraction onto the filesystem is needed.
The temporary GitHub token is sent only to the official GitHub API; signed storage
requests never receive it. Work jobs explicitly permit only contents/read; the final job permits only contents/read and actions/read.
Fork pull requests must use this read-only token model without secrets or any elevated fallback.
Artifact upload/cache services use the platform runtime mechanism. Actual fork upload and final
artifact-read access must be demonstrated in CI before rollout; an access failure stays red.

Physical artifact names append run ID, run attempt and event SHA. Semantic prefixes
and seven-day retention remain. Existing artifacts are never overwritten or deleted.
A partial rerun that mixes attempts fails closed. Use **Re-run all jobs** to produce
fresh, consistent evidence, including fresh live security lookups.

Exceptions are explicit:

1. Baseline `settings-ui-screenshots` is a legacy non-evidence upload with ignore on
   missing and hidden files disabled. It historically uploads nothing. Never enable
   broad hidden-directory collection to make it appear useful.
2. Schema ownership's warn-on-missing uploader still helps failed-run diagnostics,
   but its actual file and successful characterization are mandatory for release.
3. Raw audit attempts are complete contiguous stdout/stderr/process triples. The
   first full and production attempts and exception proof are required. Attempts 2/3
   are required only if executed. Empty stderr and even malformed/empty stdout from
   failed retries are retained as-is; terminal raw reports must bind the successful
   unchanged audit proof. Production requires zero total vulnerabilities.
4. `scoped-build-install-audit` is separate from `scoped-dependency-audit` because
   each must attest to the installation its own job actually uses.

All existing security exception pins, raw-report checks, live official lookups and
post-build runtime verification remain unchanged. The Python gate does not replace
them or invent a broader security guarantee.

## Triggers and release acceptance

The existing trigger set stays unchanged: PRs to main, pushes to main/feat/**/hardening/**,
and workflow_dispatch. The existing `ci-${{ github.ref }}` concurrency group and
cancel-in-progress behavior stay unchanged. Branch-head runs still cover stacked PRs
targeting non-main; PR-to-main runs still cover their synthetic merge commits. No
trigger deduplication, path filter, sharding or `pull_request_target` is introduced.
Repository protection settings are unchanged; a check's familiar name is not proof
that branch protection enforces it.

Before rollout: reconcile this independent change against the final combined clinical
tree; review inventory/member equality; execute negative controls in disposable CI;
run every full suite and inspect retained evidence; get independent review; and
measure actual successful PR/main timings. The observed serial baseline was 24m19–32m52
(median 29m01 across five successful runs). A future 12–16 minute normal case is a
hypothesis, not a guaranteed result or permission to remove work.


### Native container-initialization context

The runner adds one GUID-named pre-job context when it initializes service containers.
At evidence initialization, each lane captures the complete actual prior-step context:
exactly the five successful declared bootstrap steps, plus exactly one successful
empty-output UUIDv4 entry in each of the two service-backed lanes. Other lanes require
no native entry. Both full, unfiltered bootstrap and seal snapshots are retained in the version-2 receipt.

At sealing, every declared mandatory step is still required with exact success outcomes.
The only additional entry must be the same native entry observed before lane-specific audit/test/build work;
its ID, fields and outcomes and the captured bootstrap entries must remain unchanged.
Unknown, additional, failed, cancelled, skipped, output-bearing or later-injected entries
fail. The final gate revalidates the retained snapshot and native entry rather than
silently discarding unknown step contexts. Actual service IDs and distinct-host/container
checks remain mandatory.
