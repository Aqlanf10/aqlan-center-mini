# Slice 64 — existing case/plan link command

The canonical `PATCH /api/ortho/[id]` now admits the existing `planId` branch with an observed native case version. This completes that method's source conversion. The context/chooser UI is a separate next slice; this command does not expose funding or change financial policy.

| Requirement | Implementation and evidence |
|---|---|
| Independent authority | Ortho edit plus plan view and edit, even for unlink/no-op; current patient scope. `none` refuses, and foreign/missing records share the same result. A role label cannot supply missing grants. |
| Current ownership | Prove case membership, lock patient, recheck session/capabilities/scope after waiting, then lock the case. Prove old/new plans belong to that patient before ordered plan locks, repeat under lock, recheck before return. Scope includes the accepted anti-self-booking boundary. |
| Native business behavior | Extract `linkOrthoCasePlanWith(client, input)` without changing its body beyond indentation. The legacy wrapper still initializes and opens its native transaction. Canonical work uses the existing operation connection and awaited native audit. Failures roll back atomically. |
| State and concurrency | Strict positive integer IDs, exact input keys and 64-hex observed version. Terminal cases reject. Cancelled target plans reject; old cancelled plans may be unlinked. Locked/changed ownership, revoked session/grants, and injected audit failure are covered. No automatic repair of corrupt cross-patient links. |
| Outcome handling | Minimal `{ok, caseId, changed}` only. A changed link invalidates the previous version. This is not a durable receipt; unknown outcomes require a read before a new intent. A fresh same-value operation remains a no-op without another audit. |
| Compatibility | Legacy POST/PATCH/GET and 13 protected modules remain byte-exact; native writer body is exact except indentation. The preservation proof checks 857 historical source hashes and no migration change. Native plan-link/approved-agreement regressions remain. |

The frozen prior build returned **409 instead of 200** for the valid canonical link; route/helper provenance was checked against the current base. Final focused PostgreSQL passes **55 tests in four files**, unit **45 in two**, and map guards **10 in two**. Build `uxNFI5efXskzuDAyzKhUF`, types, lint and every quality/runtime gate pass. Canonical/lifecycle HTTP passes **25 in two files**, and native link/read-state HTTP passes **13 in two**, totaling **38 distinct cases in four files**.

Retained failures: a synthetic plan-edit-without-view grant document correctly failed central dependency validation; its expectation now names that refusal rather than weakening admission. Initial map verification caught missing `branches.values` and also collected stale copied tests without the required `.next` exclusion; both are corrected. Native UI tests initially polled the held request before hydration. A diagnostic observed the real section/request 962ms later with no page error; the test now awaits that real section before the same request assertion. All 13 native cases then pass with no changed timeout or product behavior.

Full PostgreSQL is still running at this checkpoint; full composed unit, final published-head CI and independent review remain open. The later Ceph layout fix requires a fresh final build and regressions. No migration, live data/settings, finance amount or signed history changed. Inventory remains NOT_READY; Docker, schema convergence and broad integration review are separate blockers.

[Source preservation, before/after checks and manifest](evidence/work-ortho-plan-link-20261101/manifest.json).
