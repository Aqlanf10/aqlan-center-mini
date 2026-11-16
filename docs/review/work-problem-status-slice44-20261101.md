# Slice 44 — independently authorized clinical problem status

Base `f28cc7ce69f887b6b75e7848a64086090b70bd40`. This contract admits only `PATCH /api/problems/[id]`, under the existing map's `clinical.visits.document` capability. Plan-edit authority alone does not grant this command. Creating a problem, assigning a clinician, changing its case link, native orthodontic management and money remain outside the slice.

## Acceptance matrix

| Requirement | Source contract | Evidence |
|---|---|---|
| Independent authority and scope | Exact document capability; none/own/all, locked patient and current responsibility; canonical never falls back | Owner/own/all success; plan editor/read-only/none/unlinked denial, outside=missing; baseline HTTP401→200 |
| Preserve clinical rules | Original shared status/audit body, same connection; all six active/resolved/inactive transitions and original resolution timestamps/actor | Real PG transitions and original specialty regressions; exact legacy-body witness |
| Refuse stale updates | Opaque stored/physical row witness, problem UPDATE NOWAIT after patient NO KEY UPDATE | ABA and concurrent content change refuse; row-only lock remains valid; two actual waiters yield one audit |
| Session and audit integrity | Post-wait authority, locked responsibility, final assertion and atomic audit | Scope removal, identity-fence revocation, expiry after UPDATE, failing audit and inverse-lock refusal |
| No unrelated clinical or financial effect | Existing care projection's problem facts only; no case/native state or reference edits | Native ortho and retained invoice/payment snapshots unchanged; hidden case association stays hidden |
| Usable independent UI | Existing RTL clinical panel; documenter does not receive plan controls, and plan editor gets no problem writer | Built HTTP, DOM and inspected synthetic 390px screenshot |
| Uncertain response | Only problem ID in a tab marker; no clinical text, automatic retry or replay; fresh read and explicit new intent | Committed response loss/reload, malformed success, unavailable storage, closing before late reply, stale/revoked UI |

The comparison token is not durable request idempotency or authorization. A physical row rewrite can produce a safe conflict. The problem remains allowed to become active again because that is the existing problem lifecycle; terminal treatment-case rules are unchanged. Changing a problem does not close or reopen its linked treatment case. The client never resends automatically, and without sessionStorage cannot promise reload recovery.

## Focused local evidence

- PostgreSQL 18.6: **137/137 in six files**, including **19 new problem-status cases**, case status, clinical graph/case/dependency commands and original specialty regressions. Initial narrower group passed 63/63.
- Built HTTP/Chromium: **60/60 across five files**: first command 47/47 in four files, then 13/13 in the existing plan-case command file. Its filename was mistyped in the first filter, so it was explicitly run before the aggregate claim. **11 new problem-status journeys**. Build `mauR3Fy9PaqVr2c6JI6zx`.
- Unit/map guards: **56/56 in five files** (46 unit, including 18 new command/version tests and three extra negative projection cases; 10 map/readiness guards). An earlier focused command accidentally also discovered `.next/standalone` copies: 63 passed, three copied-guard failures. The clean command explicitly excludes build copies and retains all 56 source checks. No assertion/threshold changed.
- Production build and final typecheck passed. Focused lint: zero errors; one warning that the separately tested `.mjs` guard file is ignored by the repository lint configuration. This is not described as zero warnings.
- **16 preservation checks** and **507 historical source hashes** at pinned revisions. The runtime allowlist adds only the existing document capability; its literal guard is updated to that exact addition. Original legacy route, creation authority, status rules, case command, money and graph writers remain unchanged.

The full unit suite for 43–44 is running separately. Full new-head PostgreSQL, hosted CI and independent review are not claimed complete from these focused results. The published base is 8e12f959 with both CI workflows successful; those workflows do not cover 43–44. No migration was allocated, no deployment or live change occurred, and the local map's 65 canonical-done / 279 existing states are not a completion percentage. Inventory remains NOT_READY. WORK Docker proof still awaits an allowed image-build path; the Alpine destination denial was not bypassed.
