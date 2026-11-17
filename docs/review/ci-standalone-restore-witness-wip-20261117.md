# Standalone restore witness — WIP

This local branch is based on `e5f3c4fbff08c098e319572d5d9d13fce2c14787`.
It adds a separately configured HTTP witness after the existing build and
preflight seal checks in CI. It has not been pushed, run in CI, or approved
for deployment. No production or patient data is used.

The planned witness creates five uniquely named, identity-checked synthetic
PostgreSQL databases on an additional disposable CI service: historical
source, fresh source, historical restore target, fresh restore target, and a
separate inconsistent-archive target. The two successful results use
different targets and storage volumes. An archive with 0079 effects but its
registry row removed has updated archive metadata. Before submitting it to the
actual standalone endpoint, the witness requires structural validation success
and confirms that the historical SQL check rejects precisely the missing row.
The endpoint must return `archive-integrity-mismatch` and a synthetic target
sentinel must survive rejection.
The two earlier targets are checked again. The witness retains its synthetic
databases and files for the lifetime of the CI runner; hosted CI normally
disposes of that runner and its service after the job. It does not upload
archives, database contents, cookies, or raw logs as evidence.

Local verification: the environment guard unit test passed 10/10 using Node
24, targeted ESLint and `git diff --check` passed, and Vitest discovered the
witness with a separate discovery-only config that omits its global setup.
The guard rejected an unconfigured environment before any database connection.
No PostgreSQL or actual HTTP witness was run on this revision, no production
build was performed, and the Node 22 CI execution and full typecheck are not
verified. Test discovery is not an execution result. A previous successful
synthetic HTTP witness on an older build does not certify this revision.

The candidate e5 implementation may reset a drill target before rejecting the
inconsistent historical archive; the new sentinel assertion intentionally
requires preservation and may fail until that separate product fix is present.
A source-only synthetic SQL probe showed the historical SQL validator rejects
an orphaned 0079 effect; it did not test the endpoint or a database. Existing
stage handling can clear the live staging directory before archive rejection;
this witness preserves a separate copy of the historical staged files and
does not claim that the original stage stays unchanged. The witness tests the
standalone build, not a complete Docker image or general secret absence.
