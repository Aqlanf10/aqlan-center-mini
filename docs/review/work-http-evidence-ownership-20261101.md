# HTTP evidence ownership after sharding

Review found a real blocker on `bf71b8b9`: both HTTP runners attempted every journey upload with missing files treated as errors. A runner correctly omitting the other shard's test would therefore fail its unrelated upload.

The explicit manifest preserves all 60 required artifact families and their 303 existing path patterns. Installed Vitest's actual sequencer assigns each producing test to one shard before the build. Upload conditions and path outputs now follow that assignment, including mixed HR and login bundles. Every owned pattern must exist, and the upload still uses `if-no-files-found: error`. Missing unowned evidence is irrelevant to that runner. Both sanitized location reports remain required on both runners. The pre-existing optional settings-directory upload retains its existing policy; no new exception was added. Retention, hidden-file flags, sanitization, test selection, timeouts and aggregate failure behavior are unchanged.

The before run passed 16 and failed 2 cases: the real missing workflow gate and an initial helper-root trailing slash that changed relative path hashing. Normalizing the helper root fixed the latter. Final ownership and existing matrix checks pass **23 tests in two files**; lint passes. The tests cover every normal file exactly once, every evidence pattern exactly once, producer witnesses, mixed bundles, missing owned evidence, malformed mappings, checkout-root independence and original upload policies. CLI assignment on this source covers **327 files as 164 + 163**, with **303 patterns as 163 + 140**. These are measured counts, not fixed partition assumptions; assignment is recomputed when tests change.

Corrected-head hosted CI remains required. This change does not make the known-defective `bf71b8b9` run successful. No test or safety gate was removed.

[Failure, final checks, partition and source hashes](evidence/work-http-evidence-ownership-20261101/manifest.json).
