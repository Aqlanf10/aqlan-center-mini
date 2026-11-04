# Registration predecessor fixture correction

The 0051/0052 registration suite deliberately removes those migrations to test their original admission and collision rules. Migration 0106 defines a trigger function using `ortho_assessment_revisions%ROWTYPE`, so it cannot form a predecessor that omits 0052. The published 650fff48 fixture tried to do exactly that and failed before reaching its assertions.

The fixture is now explicitly bounded before 0106. All 16 original collision, registry, concurrency and rollback assertions are retained. The separate `ortho-assessment-verifier-migration` test continues to execute the actual 0106 forward upgrade, verifies old payload preservation, new verifier admission and rejection of null/mislabelled versions. No migration SQL, product code or safety gate is changed by this correction.

An isolated checkout of 650fff48 reproduced the original failure in one targeted negative control (the other 15 were intentionally not selected). The fixed fixture plus actual upgrade passed all 17 tests on PostgreSQL 18.6 in 59.10 seconds. Evidence is in `evidence-registration-fixture-2026-11-04/`. The complete hosted pipeline still needs its own final result; these focused tests do not establish complete hosted acceptance.
