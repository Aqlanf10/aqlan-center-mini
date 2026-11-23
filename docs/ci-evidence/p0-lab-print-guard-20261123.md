# CI verification branch for PR #565 (2026-11-23)

Source application/test tree: `5750b8d01056b688abce3e5ff8e235c058447349` from `fix/p0-reception-lab-dispatch-print-guard-20261123-0600`.

Reason: the CI workflow listens to pushes on `main`, `feat/**`, and `hardening/**`, while PR #565 targets the deployed Staging branch rather than `main`. This documentation-only commit triggers the same code and test tree under a CI-watched ref.

Compare the source tree by excluding this evidence note. Acceptance requires all hosted jobs to succeed and independent privacy review. This is **not** a deployment or merge authorization. No clinical or production data are used.
