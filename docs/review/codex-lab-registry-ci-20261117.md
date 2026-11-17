# Grouped lab registry CI follow-up

Independent test-only follow-up to `9abbfe0f902fd61599118586b0123c9016da67ce`. The earlier hosted run `43995834156` on `d9119d33` reported failures in debt installment storage and HR runtime registration. On a newly owned synthetic PostgreSQL 18.6 database at the exact `9abbfe0f` source, runtime initialization registered 22 migrations, including 0126 and 0136. The actual 0136 name, registered SHA-256, SQL file and embedded source were checked before changing the tests.

Both original test files were red because their expected runtime registry stopped at 0126. Updated their assertions to retain 0126 and verify the 0136 record and source; no schema, runtime source or historical SQL changed. The two suites then passed **10/10** against synthetic PostgreSQL. This is not a full CI pass.

Separately, hosted run `43996863431` on `9abbfe0f` has a failed HTTP/browser shard 2. Its exact cause remains unknown: the job log is not available until the run completes, and the sanitized failure-location artifact was inaccessible from this environment. Shard 1 and PostgreSQL were still running at this report. This commit does not claim to fix the HTTP failure. No merge, PR, deployment or live database access.
