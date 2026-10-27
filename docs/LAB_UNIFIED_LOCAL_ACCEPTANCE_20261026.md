# Unified laboratory workflow — local integration, not release approval

## Source and scope

- Base: `bdd3f424d211730266e2993549f2f798fe71bec0` (sequential invoice batch; 0078–0082 retained).
- Same-order pending prescription editor: original `0a8da9ef` / `dac2ea52`, composed as `7cd24604`.
- Explicit visit/invoice work identity: selectively adapted `b3388371` / `7be2c96c`, not the aggregate `c5bf3260` candidate.
- Historical graph/backup and target capability ownership: lab-only adaptation of `bd219a25`, `d7194013`, `1ac63971`, `76ee6e1a`, and corrected lab TRUNCATE guard.
- **No 0073 authority migration, authorization replacement aliases, or aggregate clinical/authority import. No 0075 cross-domain registration.** Original plan service/category/tooth/quantity must match exactly. Existing amendment/financial-review refusals remain authoritative.
- Proposed locally registered 0074 is a new lab-only contract, not interchangeable with the older unpublished aggregate proposal. Existing `docs/proposals/LAB_SOURCE_*` records describe that historical prototype; this ledger controls current integration claims.

Fresh read-only parent evidence at 22:04 UTC: GitHub main migration listing ends at 0069; Railway Production source remains `d819fb54` and Staging source `d41573dc`, neither containing 0074. This establishes released **source** absence, not live catalog/registry absence after potential out-of-band changes. Exact live preflight/registry comparison is still a deployment gate.

## Supported workflow and boundaries

An authorized clinician can choose a laboratory, shade and exact tooth/role diagram from Today Visit; authorized manual invoice entry carries the same explicit work identities. Saving/signing creates a linked **needed/not-sent** draft, not a vendor message. Missing specification remains visibly incomplete. Valid explicit dispatch completes the same order; no duplicate order is inferred from same service/tooth/amount.

Invoice-first planned execution and visit-first invoice aliases retain their exact source relationships. Correction may preserve verified financial lineage but cannot substitute source scope. Replays retain actor/key/hash and revision evidence; cancellation does not free source identity or allow recreation.

Actual lab cost/currency remains owned by the canonical accounting editor. New source drafts have no invented price/currency or payable. Receiving uses the saved currency/FX/base snapshot, not current FX or a fallback of 1. Ambiguous commission invoice lineage refuses rather than allocating cost heuristically. Supplier purchase/payable implementation remains owned by its separate task.

Only needed prescriptions can be clinically edited. Sent specifications, source regrouping after materialization, full-arch/null-tooth scope, unlinked standalone execution, template-origin lab capture and generation/remake commands are not silently inferred. Linked payable cancellation requires financial review; linked remake requires a future explicit generation command. No automatic external message is sent.

## Restore integration finding

The former aggregate lab restore used REPEATABLE READ. Actual populated integration proved this incompatible with existing 0080 patient-number allocation, which requires READ COMMITTED. Do not weaken 0080 or globally change restore isolation. The implemented lab-only UUID insertion fence is: parent, member and alias insertion acquire the same transaction-scoped try-lock before parent lookup; missing-parent historical admission is READ COMMITTED-only and still requires the complete deferred graph. Parent/member/source INSERT triggers take that lock directly, including direct SQL. A collision raises 55P03 without retrying inside a stale transaction. Existing-parent live draft and retirement checks remain; full graph/ownership validation still runs at commit. Normal validated isolated restore retains canonical transaction framing. No restore flag, trigger bypass or arbitrary SQL permission is introduced.

## Baseline adoption and migration identity

0074 SQL/runtime SHA-256: `d4e3839ca32d053827a67f0b60b3efaddc69850f4c1d062577c541031b93195c`. The old aggregate proposal is not byte-compatible. Historical proposal files remain reference-only; never apply them beside this registered migration.

The versioned legacy order uniqueness predicate intentionally changes for explicit intents. The immutable 0001 adoption probe therefore refuses an already-extended runtime0074 database without a reviewed extension projection. This refusal is preserved and tested; the original baseline manifest is unchanged. Fresh numbered installation, runtime initialization and registered late upgrades are tested separately. No adoption workaround is authorized.

## Evidence / outstanding gates

Initial selective composition: full TypeScript check passed; 41 focused unit/component suites, 778 tests passed. Initial five PostgreSQL suites: 87 passed / 6 failed, exposing restore isolation incompatibility (plus an obsolete fixture re-sign attempt); failures are not acceptance. Subsequent final evidence must supersede these interim results.

Required before local acceptance: exact-head typecheck/lint/unit, actual owned synthetic PostgreSQL lifecycle/correction/status/FX/concurrency, registered migration/runtime/restore, fresh schema ownership artifacts and independent review.

**Desktop/mobile hosted visual, real-browser IndexedDB/Web Locks, and final print/PDF acceptance remain pending.** The locally denied Chromium socket/ptrace launch was not retried or bypassed. No build/install/public upload/merge/deploy/live migration, real patient edit, or actual vendor message is authorized by this ledger.
