# Slice 43 — scoped clinical case status

Base: `fff3e57efe9a6371c37757e73be039c2d89f52ea`. This separately committed continuation admits only `PATCH /api/cases/[id]` on the existing WORK plan. Case creation, responsible-clinician assignment and the native orthodontic lifecycle remain outside this contract. No financial rule, migration, live setting or deployment changes.

## Acceptance matrix

| Requirement | Implementation | Evidence |
|---|---|---|
| Fresh edit authority and patient scope | Existing plans.edit plus its view prerequisite; canonical envelope cannot fall back; patient lock then fresh scope and locked responsibility | Owner, own, all, none, read-only, unlinked; outside and missing equivalent; patient-wait expiry/scope removal and identity-fence revocation |
| Preserve original clinical transitions | Extracted original status/audit body on caller-owned connection; terminal cases cannot reopen; cancellation requires a reason | Eight valid transitions, three terminal refusals, original specialty regression and exact source witness |
| Independent orthodontic boundary | Ortho visibility required independently; bridged cases always stay native-managed, including for owner | Hidden-ortho denial, bridged refusal and unchanged native state |
| Reject stale state and ABA | Reader emits an opaque hash of stored case fields and physical version; locked writer compares before mutation | Active→waiting→active and same-state concurrent outcome changes refuse the old version; raw MVCC fields absent from JSON |
| Atomic effect and audit | Same admitted connection and real actor, final authority check, no rich post-commit reader | Audit trigger failure and expiry after UPDATE before commit roll back; one-connection witness; balances/responsibility unchanged |
| Bounded concurrency | Patient NO KEY UPDATE, case UPDATE NOWAIT, existing session fence | Real overlapping requests yield one committed transition/audit; inverse lock refuses without hanging |
| Lost response and UI | Minimal case-ID marker only, refreshed record and explicit new intent; no automatic replay | Real committed lost response/reload, malformed success, unavailable storage, late reply after closing, revoked access clears UI |
| Existing public identity and clinical workflow | Existing RTL clinical panel, explicit labels and cancellation reason; legacy editor and route tail preserved | Built 390px screenshot inspected; legacy regression and source preservation |

The version is a comparison token, not a durable request receipt or authority. Physical row rewrites can cause a safe conflict. A delayed manual request is not silently retried. With unavailable sessionStorage, mounted-memory recovery remains but reload recovery is not guaranteed; the UI states this. Neither outcome nor patient name is stored in the pending marker. The existing blank-outcome COALESCE behavior and original transition rules are unchanged.

## Completed local verification

- Baseline built HTTP: an authorized canonical case update returned **401 instead of 200**, before implementation.
- PostgreSQL 18.6 on a dedicated synthetic server: **118/118 in five files**, including **29 new status tests**, clinical read/case/dependency commands and ten original specialty regressions.
- Built HTTP/Chromium: **49/49 in four files**, including **12 new status journeys**. Build `OI3Xqu80lWKOB2FetNgT8`.
- Focused units: **45/45 in three files**, including 20 new status parser/version tests. Map/readiness guards: **10/10 in two files**.
- Production build, final typecheck and focused lint passed. Synthetic screenshot is retained; no real patient data was used.
- **14 source-preservation checks** and **490 historical source hashes** verified at their original pinned revisions. Legacy route tail, exact original transition/audit body, creation/responsibility authority, financial engines and other command writers remain unchanged.

The first PG command passed 62 tests but skipped ten after a shared-schema setup collision with the simultaneously running primary full suite. It is not a pass. The affected primary run was stopped (exit 130), and this continuation moved to a separate PostgreSQL server on localhost:55438. The primary batch restarted independently on 55437. The dedicated initial group then passed 72/72; the final expanded group passed 118/118. These facts are archived rather than deleting the failed evidence.

This is focused local verification, not full published-head CI or independent acceptance. The frozen primary 40–42 unit suite passed 14,329/14,329; its full PG check is separate and cannot be attributed to slice 43. The published base remains 8e12f959 while these source commits await publication. The local map now has 64 canonical-done and 280 existing ordinary methods; inventory remains NOT_READY. These are route states, not system completion. Actual WORK Docker proof remains blocked by enforced Alpine CONNECT 403; no alternate source or bypass was attempted. No migration allocated; 0090–0093 remain reserved for the separately owned Rx work.
