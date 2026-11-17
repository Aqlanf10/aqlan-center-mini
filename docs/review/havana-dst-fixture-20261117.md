# Havana DST fixture diagnosis

CI 44001047783 (e66a25cc) and its parent integration CI 43997165769
(95c338e7) each completed PostgreSQL: 3609 passed, one failed. The
2026-11-01 Havana fixture expected 50 half-hour records but PostgreSQL
returned 48. Its preceding direct SQL membership comparison passed.

IANA tzdb 2026f release notes confirm Cuba cancelled the projected
2026-11-01 rollback and remains UTC-04 through 2027-11-07:
https://www.iana.org/time-zones/releases/2026f

Independent local probes showed differing timezone data: system tzdata
2026b and Node tzdata 2026e still predict the 2026 repeated midnight.
PostgreSQL 18.6 in a newly initialized disposable local cluster also
returned midnight for both 2026-11-01T04:00Z and T05:00Z. This explains
why a projected future rule is unsuitable as a fixed regression fixture.
The exact tzdata package version inside hosted CI was not read directly.

The test now uses the historical 2025-11-02 transition, retaining 50
records and adding explicit midnight and record identity assertions.
The old narrow range returns 48, losing IDs 3 and 4. No production query,
migration, real database, or financial policy changes.

Validation on isolated PostgreSQL 18.6:
- Targeted PostgreSQL suite: 5/5 passed.
- Actual mutation replacing the widened query with the old narrow range:
  1/5 failed at exact record membership (missing IDs 3,4); restored: 5/5.
- clinic-day-sql unit tests: 2/2 passed.
- Target-file ESLint and git diff --check: passed.
- Full tsc could not complete: default heap OOM; 4 GB retry exit 137.
- No hosted rerun, push, merge or deployment performed.
