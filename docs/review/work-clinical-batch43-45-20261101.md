# Combined clinical batch 43–45 — acceptance in progress

Product source `2b4e5f4bad08297212870c7c318380377567e73e`, build `DyLznC2ConMfswaBdRqwY`. The strict dependency-parser correction is separately committed at `db16763d`. The local handoff restoration is separately committed at `641442f3`. These are not yet published at this checkpoint.

Confirmed final-source local gates: 74/74 HTTP/browser cases across six files, successful production build and standalone typecheck, full lint with zero errors and 345 existing warnings. Slice45 focused PG passed 94/94 in four files. Historical 43–44 full PG passed 5,093 and full unit passed 14,370 at its frozen source; neither result covers45.

The first combined full-unit attempt before the parser correction passed 14,393 with one unchanged development-tracing timeout; the isolated unchanged five-test group passed. The next full run after that correction passed 14,394 with two inventory guard failures out of 14,396. Its inventory still held the digest from before the parser change. An initial regeneration command used the projection-inventory scanner, which does not update this exhaustive inventory. The correct `staff-cutover-readiness.mjs --write` changed **only sourceDigest**, with classifications, counts and NOT_READY unchanged; all ten inventory/map guards then passed. No assertion or timeout was altered. All failed attempts remain evidence rather than being relabelled as passing.

The full unit suite is being rerun with the corrected inventory. Full PostgreSQL for the final source, exact-head CI, independent review and WORK Docker evidence remain separate pending gates. [Inventory correction and actual logs](evidence/work-clinical-batch43-45-20261101/inventory-correction.json). No source or package change was needed for the inventory correction.

No deployment, account change, migration or live data operation occurred. The previously enforced Alpine destination refusal remains; no alternate package mirror or security bypass was attempted.
