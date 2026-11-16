# Slice 42 — scoped plan dependency add/remove

Base: `b21b151c504128f853f58059ddd3cf689e7f125b`, same WORK branch. This slice admits `POST` and `DELETE /api/plan-items/[id]/dependencies`, with the existing plan-edit grant and its view prerequisite. The current case/plan read remains the only feed for this clinical editor. No case creation, finance/proposal reader, migration, live activation or deployment is included.

## Acceptance matrix

| Requirement | Implementation | Evidence |
|---|---|---|
| Canonical edit authority and scope | Canonical envelope, no fallback for canonical accounts; none fails, own requires existing responsibility, both endpoints belong to one patient | Built baseline 401→201; PG and HTTP owner/own/all/none/read-only/unlinked and outside=missing |
| Stable graph and fresh authority | Same patient UPDATE lock as the legacy graph writer; ordered item/plan locks with NOWAIT; post-wait session/scope, locked responsibility, final assertion | Real overlapping inverse additions and deletions; expiry, scope removal, revocation at identity fence and inverse item-writer refusal |
| Preserve clinical rules | Existing cycle detector, requirement semantics and shared add writer; removed edge only through extracted original delete/audit body | Legacy specialty regressions; cancelled-plan endpoints, duplicate/cycle refusal, exact source witnesses |
| Bound processing without partial graph | Add requires at most 2000 items and fewer than 4000 existing edges; foreign references refuse; deletion can reduce an oversized graph | Real node/edge boundary fixtures and deletion witness |
| Prevent stale deletion of a recreated edge | Reader emits a SHA-256 version of stored edge fields, exact timestamp text and MVCC tuple identity; delete locks and compares it | Delete/recreate within one transaction timestamp; stale HTTP deletion; row-only lock preserves version; no raw physical fields in JSON |
| Atomic mutation and audit | Same admitted connection and real actor; caller-owned original delete helper | Audit-trigger failure rolls back add/remove, one connection/no initializer or pool escape |
| Lost-response handling | Minimal tab marker before mutation; no note in storage, no automatic replay; refreshed graph and explicit new intent | Real browser committed add/remove with lost response and reload, malformed success, storage refusal, late reply after closing, revocation |
| Existing UI and identity | Explicit RTL labels, existing clinical layout; reader has no command controls; independent old case workspace unchanged | Synthetic 390px screenshot inspected; HTTP/DOM and source witnesses |

The comparison version is not a durable request receipt. A physical rewrite can invalidate it safely and require a fresh read. A recreated row, including an identical row in the same transaction timestamp, has a new witness. The add command intentionally retains the legacy lack of permanent request idempotency: a delayed manually resubmitted add after a later removal is a new possible operation. The client never automatically resends it, and matching current state does not attest which request produced it. With unavailable sessionStorage, mounted-memory recovery remains but recovery after reload is not guaranteed; the UI says so.

The reader still exposes only clinical fields. The added opaque version does not disclose timestamps, xmin or tuple addresses. It is not authorization and cannot bypass current patient scope or grants. The existing 2 MiB whole-response bound remains; no graph truncation was introduced. Dependency state remains a clinical warning, not a new execution prohibition, billing rule or money movement.

## Completed focused validation

- Native PostgreSQL 18.6: **107/107**, five files, including **21** new dependency cases, case command/read suites and existing commission-attribution/specialty regressions. Earlier reader/dependency group passed 64/64 before expanding the race and edge-limit witnesses.
- Built HTTP/Chromium: **37/37**, three files, including **13** new dependency journeys. Final build: `eVAs967ymX9nktdV8mD9y`.
- Final focused unit/guards: **56/56**, five files: 46 unit checks (including three negative version cases) and 10 map/readiness guards. The earlier 43/43 run predates the extra version cases and is retained.
- Focused lint: zero errors/warnings. Final production build and its typecheck passed. The first typecheck/build correctly rejected the unhandled `none` session-envelope union; the route now explicitly sends unauthenticated/legacy envelopes through the unchanged legacy guard, while denied/canonical envelopes cannot fall back.
- **13 source preservation checks** and **472 historical hashes** verified at their own pinned revisions. The original add writer, clinical/financial engines, case command/editor and both legacy route tails are unchanged. The remove helper moves only transaction ownership and indentation.

The complete unit and PostgreSQL batch checks are still running at report creation. The first full unit attempt reported the existing development-runtime-tracing timing failure (5052 ms); a separate unchanged test passed 5/5 in 3.97 s. It also exposed a local command setup omission: SESSION_SECRET was not supplied. An isolated signer test reproduced that exact error, then passed with the documented synthetic CI secret, without a code change (8 other cases filtered in each diagnostic). This does not relabel the failed full attempt as success. Its complete result and any final rerun must be recorded before claiming the local batch gate. Full hosted HTTP, runtime packaging and final exact-head CI remain separate gates.

No new permission grant or owner mapping was fabricated. Inventory remains `NOT_READY`; 63 converted / 281 existing ordinary methods are route-map states, not whole-system completion. Legacy case creation and wider plan workflows remain open. Alpine CONNECT HTTP403 still blocks a local actual Docker image; no bypass or mirror was used. The proposed WORK-only CI image workflow remains outside the repository pending coordination under HANDOFF §1.5. The limited parent review of the earlier main integration does not cover all other compatibility conflicts.
