# Standalone patient file numbering

## Provenance and boundary

Extracted from reviewed recovery source `9c31e071a332cc6456c33369ebcc40596451568c`
onto Production-base `25634bd646daf7f368349778b5796cf6972f9900`, then integrated
with main `b55401693700d83c063872f957758f249dd1deed` for independent PR490
verification. This includes main's published `0089_lab_shade_specification.sql`;
it does not include the separate extended lab-intent slice or cancelled portal492.
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
lower the sequence. Current-main integration includes0089; regenerate candidate
current-schema/preflight artifacts from an owned synthetic database and test both
late0080 over established0089 and fresh startup. Published0080 and0089 bytes are
immutable. Candidate artifacts are not a rewrite of the historical baseline.

## Interpreting count-only evidence and historical Stage residue

The numbering CLI adds `numberingDeploymentAssessment` with `status: HOLD` and
`deploymentAuthorized: false`. It is evidence collection, not an authorization
engine: even `ready:true`, `matchesFiles:true`, and exit0 cannot establish schema
compatibility, backup readiness, CI, a safe rollback artifact, or owner acceptance.
Alias ambiguity still returns exit2. Missing/failed evidence never authorizes
cleanup, alias merging, history adoption, or a migration rewrite.

The original registry report stays visible. Unknown applied migrations, checksum
or name mismatches, absent registry, and failed alias readiness are explicit
blockers. Missing registrations require exact target-history review: established
runtime gaps are not silently populated and are not declared corrupt merely
because a full CLI baseline differs. Before startup, identify precisely which
migration will be added and demonstrate that all other rows remain unchanged.

Stage may retain0090 history/schema after the cancelled portal application was
rolled back. Application rollback does not reverse database migration history.
Do not register0090 in this candidate, copy cancelled portal code, reuse its
number, fabricate a baseline, delete its registry row, or drop its objects. If
preflight reports unknown0090, hold deployment until its actual historical
checksum and affected catalog objects have been characterized and compatibility
with this exact candidate has separate reviewed evidence. An unknown version is
not itself evidence of compatibility. The runtime migration helper checks only
supplied migrations and must not be relied on to stop startup because0090 exists.

## Protected backup and compatible rollback runbook

These are required evidence steps, **not instructions to mutate a live target**.
No usable live backup or rollback artifact is claimed by this source document.

1. Record exact candidate commit/image digest, target environment, PostgreSQL
   major version, immutable migration checksums, count-only registry/readiness
   result and the reviewed expected pre/post migration delta. Keep secrets,
   patient rows and raw database logs out of published evidence.
2. Before authorized startup, verify a protected complete backup and restoration
   path, including database, durable document assets, integrity metadata and
   retention. Record a non-sensitive backup reference and verification timestamp;
   do not delete or replace existing backups. Restore rehearsal uses a separately
   isolated owned synthetic target, never a destructive live restore.
3. Prove official SQL and full-archive restore preserve current aliases, retired
   aliases, policy minimum/version, internal patient IDs and clinical/financial
   links. Preserve sequence high-water (including gaps); allocation after restore
   must exceed current/retired maxima and never fall below7000. Do not use a
   restore as a mechanism to reuse identifiers or lower policy/sequence state.
4. Pin a previously verified **numbering-compatible** rollback image or prefer a
   forward fix retaining0080 and its allocator/import/edit/restore guards. A
   pre-numbering main/Stage artifact is not a compatible rollback just because
   its health endpoint passes. Verify rollback compatibility on the post0080
   synthetic schema, including any separately reviewed historical residue.
5. Before Stage owner trial, require full CI on the exact integrated candidate,
   independent review, resolved target-schema/readiness blockers, protected
   backup proof and a pinned compatible recovery artifact. Stage trial must test
   new allocations, a reviewed synthetic legacy correction, stale/duplicate
   refusal, old-alias reservation and unchanged linked identities. Production
   promotion remains separate and follows successful owner Stage acceptance.

## Verification boundaries

Focused synthetic PostgreSQL18.6 tests cover allocation/import/edit concurrency,
CAS, authorization expiry, immutable history, audit rollback, unchanged linked
financial rows/balances, current0087 late upgrade with registry gaps, restart,
checksum refusal, and official SQL/full-archive/staged restore.

Exact commands and final test counts belong in the release PR. Historical PR483
results are not evidence for this extraction. Real browser, hosted CI, Staging,
backup readiness and Production checks must be reported separately, never inferred
from focused tests. No real patient data belongs in published evidence.
