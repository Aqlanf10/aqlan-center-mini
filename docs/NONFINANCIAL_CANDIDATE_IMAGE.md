# Nonfinancial candidate image verification

`.github/workflows/nonfinancial-candidate-image.yml` adds an isolated image check
for a same-repository pull request from `integration/nonfinancial-20261022` to
`main`. It does not change the existing full CI, required-check configuration,
Dockerfile, `.dockerignore`, or deployment policy.

## Trigger and exact source

The workflow runs on PR open, head synchronization, reopen, ready-for-review,
and edit events. There is no path filter. Other source branches and fork PRs
skip the image job; their skipped result is not candidate image evidence.
The branch name is intentionally narrow, not a reusable release approval.

Checkout explicitly selects the event's immutable PR head SHA, not GitHub's
synthetic merge commit or a moving branch. A fail-closed shell verifies the
checkout SHA and clean source. A new head requires a new successful run;
concurrency cancels superseded runs for the same PR.

## What a successful check proves

- GitHub-hosted Ubuntu built the actual unmodified multi-stage Dockerfile from
  the checked-out head and the committed dependency lock/vendor inputs. Build
  network access is required for the existing official Node/Alpine/npm sources.
- Three smoke commands run with no network, a read-only root filesystem,
  UID/GID 1001, all capabilities dropped, and no new privileges. They check the
  packaged artifacts and Node major, parse the server, and invoke only packaged
  preflight `--help`, bypassing the normal application entrypoint.
- The success-only job summary contains only commit/tree IDs, Docker input
  hashes, a local image ID, and fixed statements of scope. The image ID is not
  a published registry digest. No artifacts or full image configuration are
  uploaded; no secrets, repository environments, or deployed databases are used.

## What it does not prove

This is not a deployment, real database preflight, application startup or HTTP
health test, entrypoint/volume-permission test, or Railway Production check.
It does not replace full CI or independent review. A cancelled, skipped, failed,
or previous-head run cannot support promotion of the current candidate.

Local workflow regression tests use synthetic Git repositories and a fake
Docker command to test source binding, command construction, fail-closed
behavior, and offline assertions. Those tests do not build an image. If Docker
is unavailable locally, only a successful hosted run for the exact final head
can close the image-build verification gap. Review only the allowlisted summary
and structured job status when collecting evidence, not raw logs/artifacts.
