# Document HTTP framing regression diagnosis

Hosted CI 44001047783 job 133770265117 annotation identified the failure:
__tests__/security-http/document-associations-http.test.ts:109 expected
Content-Length "70", received null. Full job log connector repeatedly
returned Transport closed; the public GitHub job annotations were read
in the browser instead. Do not claim the full hosted HTTP log was read.

Installed Next 16.4.5 server/send-response.js deliberately excludes
content-length, content-encoding, transfer-encoding when copying Fetch
Response headers, to avoid invalid framing after transparent decoding.
A standalone local probe using actual Next sendResponse and NodeNextResponse
sent 70 synthetic bytes: status200, content-length=null,
transfer-encoding=chunked, received body exactly70 bytes and byte-equal.

Test change removes only mandatory Content-Length presence. It explicitly
checks received byte length and full byte equality; content type, private
no-store, nosniff, database associations, and foreign-doctor denial remain.
No production behavior, authorization, storage or migration changed.

Validation used copied existing local Next16.4.5 build and a newly initialized
synthetic PostgreSQL18.6 cluster, not any clinic database:
- Original test: 3 pass,1 fail reproducing null vs "70" at line109.
- Corrected test:4/4 pass using real authenticated HTTP and file storage.
- The harness stopped its server and dropped its isolated aqlan_sec_http DB.
- Target-file ESLint and git diff --check passed.
- Shared base full typecheck: OOM at default heap;4GB retry killed(exit137).
- No new build, full suite, hosted CI, push, merge or deployment claimed.
