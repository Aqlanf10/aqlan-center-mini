# Orthodontic coverage — locally registered and verified; browser/release gates remain

The earlier `518d4fdb` checkpoint was untested and blocked. This local return-visit composition repairs those identified blockers without changing prior registered migrations or signed historical classifications.

## Repaired and tested
- A signed visit freezes exact adjustment/case/revision/recorded-patient identities in a manifest. Proof-bearing signed adjustment rows cannot be changed or deleted. No ordinary signed visit can acquire a new manifest retrospectively.
- Restore inserts historical signed parents and their exact children with guards enabled; deferred constraints require complete parent/child agreement. No trigger bypass or spoofable restore session flag is used.
- Revision chains validate immutable recorded source identity and order. Live writers separately validate current ownership/source under locks; historical replay after cancellation or legitimate ownership reassignment does not reauthorize new work.
- Current invalidated source is review-required in financial context and checkout; historical INCLUDED classification and proof remain unchanged.
- Protected reset refuses populated coverage history before backup; coordinated empty reset succeeds. Backup orders revisions by case/version before signed visit manifests.
- Multiple adjustment rows with an explicit decision refuse the ambiguous single-decision signing path; one case's coverage is never copied to another row. Existing multi-adjustment paths without an explicit decision remain unchanged.
- UI distinguishes no additional charge from payment of existing agreement debt. Extras retain independent billing.

## Recovery review repairs
- Pending decisions use the shared durable IndexedDB financial-command journal. Ambiguous network, authorization, redirect and server errors do not erase a pending request. Only an exact committed receipt or durable refusal status acknowledges it.
- Refusals are immutable and mutually exclusive with a success for the same command. Current-owner authorization allows exact original command reconciliation after a patient merge without changing historical patient/source identity.
- Recovery discovers same-actor, exact-case original journal scopes after a merge; multiple pending commands require explicit selection. Other financial workflows remain fenced.

## Local evidence before registration
- At `9a4de01a`: 72 unit suites, **1,363 passed**, TypeScript passed (Node 22, 3072 MB heap). Changed-file lint: zero errors; existing surrounding warnings retained.
- At `68e4ffcb`: PostgreSQL 18.6, **18 suites, 205 passed**, including restore/reset, exact command outcomes after merge, source cancellation/signature races and existing orthodontic flows. Missing-evidence expectations changed to REVIEW_REQUIRED; explicit exclusion, monetary and ownership assertions preserved.
- Earlier archive-payload tests manually initialized the proposal on isolated synthetic databases. Those results are NOT migration-driven `stagedRestore` acceptance.
- Independent recovery rereview closed the identified command-recovery blockers at `2017a31b`.

## Registered local acceptance
- Source/test checkpoint `3b7210f54c6360dee61a05e093128e89443dfea3`, tree `0430fac0cb2e642b78aabc23ec013af36b56b21b`.
- Official `0079_ortho_followup_coverage.sql` and runtime constant are byte-identical, SHA256 `5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99`. Prior registered migration bytes are unchanged.
- PostgreSQL 18.6 generated contract and additive-only disclosure pass; 210 disclosure additions, no prior identity/text changes or drops. Ownership has zero unexpected differences, with the same 16 pre-existing findings.
- Registered affected unit acceptance: **20 suites / 165 tests passed**. TypeScript passed with Node 22 and 3072 MB heap. Targeted lint: zero errors, nine existing surrounding warnings.
- Registered PostgreSQL acceptance: **6 suites / 32 tests passed**. Actual migration-driven `stagedRestore` preserves all non-registry rows, immutable success/refusal outcomes, and signed proof after source cancellation and supported patient merge deleting the old patient. Exact equality remains checked before and after application reads.
- Both CLI and bounded runtime add missing 0079 after existing 0080/0081/0082 without changing signed/financial rows or previous registry entries. Mismatched checksum/name and unregistered hand-installed proposal objects refuse rather than being adopted.
- Protected empty reset, populated-history refusal before backup, registered source/signature races, existing revision registration, ownership and numbering upgrade suites pass.
- The initial registered run found only a stale table-count fixture and a synthetic doctor created without canonical commission history. Fixtures now assert both new tables and create the doctor through `createParty`; no equality check or application guard was weakened.

## Remaining gates
Matching desktop/mobile browser verification and exact-head build/CI belong to root and remain unclaimed. No build, installation, publication, deployment, Production access, or real patient modification is claimed by this worker. This local result is not a release or Production acceptance certificate.
