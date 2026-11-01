# Slice 57 — next bounded contract: immutable orthodontic strategy append

Source base: local 56 commit 177825e5, while its full gates run in the other frozen worktree. Published WORK remains 7f586db2; no local prep branch is pushed.

Scope is POST /api/ortho/[id]/strategy and the minimum existing editor/choice projection needed for that command. Reuse the native strategy command, immutable revision/fingerprint, bound snapshots and audit. No new treatment/financial effects, bridge creation, prices, clinical recommendation engine, migration or change of historical results.

Existing policy: clinical.ortho.edit and its view prerequisite plus current patient scope. The legacy contract requires independent plan visibility and edit authority for adding, retaining OR removing plan links, including original/predecessor links during replay. Preserve that rule through existing clinical.plans.view/edit capabilities. Read grants alone never imply write grants. Historical current foreign references may only contribute unavailable markers; no foreign clinical or financial details.

Admission and concurrency must use one owned connection and fresh authority after waits, with explicit lock order that does not invert native plan/item/bridge writers. Preserve strict same-actor command identity and fingerprint; exact replay is distinct from a new command and cannot bypass current authority. Test actual waiting competitors, expiry/revocation, foreign/moved references, audit rollback, no legacy fallback, malformed bodies and nonempty finance invariance.

Inspect and reproduce the possible writer-to-reader budget gap before changing it: accepted canonical reads bound history to 5000 revisions/8 MiB and the historical reference union to128. A successful new write must not strand that reader. Do not raise bounds or silently prune history. Any shared legacy change needs its own causal witness and compatibility gates.

The UI must reuse the existing draft/command owner; no independent browser receipt protocol or automatic replay. Keep source/projection budgets and all late-response/draft/session boundaries. Test positive empty/existing linked cases and plan visibility/edit combinations, lost committed response, refresh and revoked authority, and preserved legacy390/1280 workflows.

No new policy is inferred. If a missing choice/authority decision cannot be determined from the accepted contract, hold only that part and document the specific question. Full local and exact-head CI plus independent review remain separate acceptance gates.


Implementation boundary clarified during source inspection: 57 is the command contract, with the default GET still reference-only. Editor choices and the embedded legacy draft-owner extraction form the following58 contract. This avoids silently expanding read responses merely because an editor capability exists. They will be reviewed as separable parts of the coherent assessment/strategy workflow batch.

Legacy strategy reads are historically unbounded, unlike the assessment reader. This slice therefore preserves legacy strategy write budgets and applies the already accepted canonical history/reference bounds to canonical append only; it does not redefine legacy policy or claim the whole legacy store has adopted canonical resource limits. Histories beyond those bounds remain explicit adoption/readiness work, not silent truncation.
