# Restore witness parallel diagnostic — WIP

This branch is based on `b1a2056f8e7ecdc58e4a25747adfe1a479a09b7c`.
It removes only the restore witness job's dependency on the quality job so
the existing standalone HTTP/PostgreSQL witness can run concurrently while
quality is still running or has failed. Its runner, synthetic service,
fixtures, build, runtime guards and seal checks remain unchanged. The
required-completion job still requires quality, PostgreSQL, HTTP, print and the
restore witness all to succeed; no existing job or gate is skipped or relaxed.

A successful witness is evidence only for that diagnostic job on the exact
revision tested. It is not a successful full CI run or a deployment decision.
At this local checkpoint, no CI run or actual HTTP/PostgreSQL execution has
been performed for this branch. The change adds no local probes, database
contents, archives, environment identities, build artifacts or deployment
steps.
