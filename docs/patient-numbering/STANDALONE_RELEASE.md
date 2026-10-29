# Standalone patient file numbering

## Provenance and boundary

Extracted from reviewed recovery source `9c31e071a332cc6456c33369ebcc40596451568c`
onto Production-base `25634bd646daf7f368349778b5796cf6972f9900`.
The first published numbering source was the mixed commit
`0b654f4c563a21011e4dd16b18308e0fdd2329a2`; that commit and PR483 are **not**
merged wholesale. No canonical staff identity, inventory reconstruction, or AI/Dot
feature is part of this slice. Existing admin/session authorization remains intact.

Published migration0080 is unchanged. SHA256:
`b2bee7694f0781775bbddeea3715cb16ab701f4ee3fd748785ef1016c0f2e10a`.
It is registered independently after0078 and before0087 in fresh startup, and can
be applied late to an established0087 runtime registry without adopting its gaps.
No migration renumbering, baseline manifest rewrite, or historical renumbering.

## Operator contract

- New allocation is **at least7000**, displayed `P-07000`; existing sequence,
  current numbers, or retired numbers can require a higher actual next number.
- Existing paper aliases are changed individually through the admin-only patient
  identity editor. Input `123` becomes `P-00123`; historical values below7000 are
  allowed. The future floor does not constrain manual archive corrections.
- Exact current alias, version, and reason are required. Stale and duplicate
  changes are refused; audit failure rolls the alias/version/history back.
- Internal patient IDs, receipts, invoices, contracts and linked financial/clinical
  rows remain unchanged. Saved documents remain unchanged; live reprints show the
  current alias. Changed numeric login aliases stop working; existing signed tokens
  with a different exact alias are invalidated. Case/whitespace-only legacy
  spellings can still match normalized login input. Inform the patient.
- Old aliases are permanently reserved, including after patient deletion/merge.
  They cannot be reassigned or swapped automatically. Resolve paper conflicts by
  explicit review, never deletion or automatic canonicalization.
- Reset refuses before backup/mutation if current patients or retired aliases
  exist. It retains numbering policy and never restarts the patient sequence.

## Deployment / rollback gates

Before any deployment/startup migration, run count-only readiness through an
explicitly authorized read-only operational connection:
`npm run db:preflight -- --patient-numbering-readiness`.
`ready:false` / exit2 is a hard blocker, not authorization to change data.
This check does not itself certify all schema/registry equivalence. Compare the
actual target registry and exact migration checksums; preserve known gaps.

Verify a usable protected backup/restore path, full CI, independent review and
Staging acceptance before Production promotion. No live-readiness result,
Production patient edit, or deployment is implied by source publication.

Migration failure is transactional; unchanged historical rows and registry are
covered by synthetic late-upgrade tests. Once0080 is installed, do **not** assume
old-base application rollback is compatible: its old allocator lacks the future
policy and retired maximum. Prefer a compatible forward fix or an independently
verified artifact that retains numbering. Never down-migrate/drop history or
lower the sequence. Combining0089 requires fresh combined schema artifacts and
acceptance; the standalone release does not register0089.

## Verification boundaries

Focused synthetic PostgreSQL18.6 tests cover allocation/import/edit concurrency,
CAS, authorization expiry, immutable history, audit rollback, unchanged linked
financial rows/balances, current0087 late upgrade with registry gaps, restart,
checksum refusal, and official SQL/full-archive/staged restore.

Exact commands and final test counts belong in the release PR. Historical PR483
results are not evidence for this extraction. Real browser, hosted CI, Staging,
backup readiness and Production checks must be reported separately, never inferred
from focused tests. No real patient data belongs in published evidence.
