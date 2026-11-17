# WIP: finance, prescription and commission evaluation — 2026-11-17

**NOT READY: the draft prescription SSR and PDF witnesses are red. Targeted passing tests are not acceptance or release approval.** The draft witnesses are unchanged from prescription source `c40463e2`; the SSR witness fails with `synthetic-not-found`, and the PDF witness with `NEXT_HTTP_ERROR_FALLBACK;404`. The decision on draft printing remains unresolved. Do not weaken either witness or infer a policy decision from this trial.

## Scope and provenance

This local evaluation worktree is based on `3d7dbbbdb161f15f68712a456c1b9891b46557c5` (finance, retired 0079 compatibility and bounded preflight). Changes were selectively applied from prescription source `c40463e26acdc6d0c35b9390b643d15fa3457953` and commission source `5cf24245d191fda5ef815afdf7be5a7d06efab66`, using `8aebc811` as their common source base. Finance CI fixture/documentation fix `d879518626b93b0d73d8d845a052352fdba89c8a` was applied without conflict. No Git merge, push, deployment, production access, or patient data was involved. This is not a completed booking implementation: 0090 supplies booking preference metadata only. Commission 0134 and the both-settings-off decision remain incomplete.

The legacy 0079 migration file is retained byte-for-byte (SHA-256 `5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99`). Runtime migration inventory contains 80 files; fresh runtime records 79 because retired 0079 is not applied, while a historic database can retain all 80. Combined PG18 schema and disclosure fixtures include the new migrations and retain historic fingerprint entries. The capability inventory remains `NOT_READY`; no staff authorization policy was relaxed. Settings conflict resolution preserves both owner-only finance refusal and medication-catalog session authority; an added mixed-batch test verifies rejection before writing.

Migration SHA-256 values retained for audit:

- 0090 `608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25`
- 0091 `d075fd6222bf8204c2e7de2ea536b66c8f8db71178eaa70de2294f0dba227044`
- 0092 `587529f146e1bf72fc654cff4fbacb0f233729efaadf26e44fdfde8e802af240`
- 0093 `7bf8a45c76d1a52b0efa0fae0b0427fb33a079b2be1aced8fc2560e8cf8336dc`
- 0128 `a95ea485b8e3bd1ca6e5854a251337e739de01566c64071ad3fad84483a0dd54`
- 0129 `cde38e4a7df3f2399cd504c03193263931dbd126c29ee178c6a173c89b4d4f46`
- 0133 `8d1a1ef54722c61a142839fcbe2cefe5abede436a167b66ed1e94c784c70b419`

## Targeted evidence

Tests used a separate synthetic PostgreSQL 18.6 instance on localhost. Some test fixtures deliberately reset their own synthetic database; none touched a shared or production database. Results below are scoped to the indicated worktree state, not a CI or release verdict:

- Before the test/documentation-only CI fix, PG integration was **70/70** on staged tree `fad81b5eb7366ad27a8445739c1c3d44f5b2caa8`, covering historical and fresh 0079, finance upgrade, prescription issuance and migration lineage.
- After the CI fix, finance CI regression tests were **19/19** and grouped laboratory / commission PostgreSQL tests **26/26** on staged tree `0f76b81d06f6e3458d82bedf2c1a11caa556c4ed`. The mixed-currency test verifies costs are not allocated across incompatible currencies. PG emitted a client-query deprecation warning.
- The original history restoration suite plus the added combined finance/Rx/0079 restoration suite were **8/8**: a synthetic archive preserved old 0079 decisions/proofs, finance receipts and a 0093 prescription receipt, blocked receipt mutation, preserved expense replay and rejected a retired request. The Rx history guard takes precedence when both protected histories are present; the original separate 0079 guard test remains intact.
- Preflight and schema fingerprint PG tests were **11/11** against fresh and historic 0079 states. Settings route tests were **14/14**, including a mixed catalog and owner-only funding batch that must not write.
- Unit run: **119 passed, 1 failed** (draft SSR). Print-visual run: **4 passed, 1 failed** (draft PDF). Neither draft witness was edited relative to its source. TypeScript (`tsc --noEmit --incremental false`) passed on source commit `2b0ccb65640998abf0b574f3f8b0a1ce2cf0d228`, including the added restoration and settings tests. The subsequent commit updates only this report.

The finance CI failure was reproduced as `exceeds_drawer_cash`: synthetic shifts started at zero. The targeted fix gives the synthetic shift sufficient opening cash and asserts no refusal reason; existing behavior assertions remain. Migration documentation now includes 0128, 0129 and 0133. This does not change the production cash limit.

No full test suite or final CI acceptance is claimed. Daily adjustment workflow and excluded orthodontic feature work are outside this evaluation. A policy decision and a fix with both draft witnesses green are still needed before considering this combined work ready.
