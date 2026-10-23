# Finance candidate image verification

`.github/workflows/finance-candidate-image.yml` adds an isolated image check for
the same-repository pull request from `integration/finance-candidate-20261022`
to `main` (#429).

The owner approved adding this workflow directly, for production-image testing
only, with no deployment and no change to security permissions.

The workflow is byte-for-byte the reviewed
`nonfinancial-candidate-image.yml` except for:
- its name;
- its concurrency group;
- the source branch;
- the local image tag.

It does not change the existing full CI, required-check configuration,
Dockerfile, `.dockerignore`, deployment policy, secrets or repository
permissions (`contents: read` only).

## Trigger and exact source

The workflow runs on PR open, head synchronization, reopen, ready-for-review
and edit events. There is no path filter.

Other source branches and fork PRs skip the image job. A skipped result is not
candidate image evidence, and that includes the inherited `image` jobs of the
other candidate workflows. The branch name is deliberately narrow; it is not a
reusable release approval.

Checkout selects the event's immutable PR head SHA, not GitHub's synthetic merge
commit or a moving branch. A fail-closed shell step verifies:
- the checkout SHA;
- that the source is clean;
- the commit tree;
- the Dockerfile and `.dockerignore` hashes.

A new head needs a new successful run. Concurrency cancels superseded runs for
the same PR.

## What a successful check proves

- **Build:** GitHub-hosted Ubuntu built the unmodified multi-stage Dockerfile
  from the checked-out head and the committed dependency lock and vendor inputs.
  The build needs network access for the existing official Node, Alpine and npm
  sources.
- **Isolated smoke commands:** three commands run with:
  - no network;
  - a read-only root filesystem;
  - UID/GID 1001;
  - all capabilities dropped;
  - no new privileges.

  They check the packaged artifacts and the Node major version, parse the
  server, and run only the packaged preflight `--help`, bypassing the normal
  application entrypoint.
- **Summary:** the success-only job summary contains only:
  - the commit and tree IDs;
  - the Docker input hashes;
  - a local image ID (not a published registry digest);
  - fixed statements of scope.

  No artifacts or full image configuration are uploaded. No secrets, repository
  environments or deployed databases are used.

## What it does not prove

This check is not any of the following:
- a deployment or a Railway Production check;
- a real database preflight;
- an application startup or HTTP health test;
- an entrypoint or volume-permission test.

It does not replace full CI or independent review. A cancelled, skipped, failed
or previous-head run cannot support promotion of the current candidate.

## Local regression tests

`__tests__/finance-candidate-image-workflow.test.ts` mirrors the nonfinancial
workflow tests. It uses synthetic Git repositories and a fake Docker command to
test:
- source binding;
- command construction;
- fail-closed behavior;
- the offline assertions.

These tests do not build an image. Only a successful hosted run for the exact
final head closes the image-build verification gap. When collecting evidence,
review only the allowlisted summary and the structured job status.
