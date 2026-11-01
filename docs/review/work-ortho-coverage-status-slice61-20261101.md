# Slice 61 — exact durable followup-coverage outcome

`PUT /api/ortho/[id]/followup-coverage?patientId=…` reads the result of one exact previously submitted command. It does not create a coverage decision, reject an unresolved command, issue an invoice, alter money or authorize another request. The existing POST writer and editor remain separate contracts.

| Requirement | Code and verification |
|---|---|
| Exact current authority | Mapped `finance.agreements.manage`, its central prerequisite and patient scope on the admitted connection. Owner, own and all positive; none, unlinked and adjacent-role negative. Missing/outside responses are indistinguishable. Current patient ownership is necessary even for an old committed receipt. |
| Genuine terminal outcome | Native parser, actor-user-ID request fingerprint, immutable committed/rejected/unresolved semantics and command advisory key are reused. Another actor, changed payload, corrupted actor or malformed receipt cannot impersonate successful recovery. Missing remains unresolved. |
| Waits and transaction | Same receipt fence as the existing writer, then fresh authority, patient/case SHARE NOWAIT and positive own-scope membership. Final authority before return. Real writer commit and rollback are observed after lock release; session expiry, scope removal, revoked grants and inverse locks refuse. The owning transaction is READ COMMITTED with locks; no RR or SQL READ ONLY claim. |
| Bounded projection | Each candidate receipt is bounded to 16 KiB in SQL before materialization. The commercial source snapshot, invoice values and invoice/service names are never returned. Native exact recovery matchers validate the minimal projected outcome, including the supplied immutable source identity. |
| No effects | Nonempty invoices, plans, receipts, rejection history, clinical cases and full audit remain unchanged. No initializer, pool query, audit write, fabricated legacy identity, implicit activation or migration. A disabled substrate guard gives 503 without manufacturing an outcome. |
| Compatibility | Existing GET and POST bodies, legacy PUT body, native status transaction wrapper and decision writer bodies are unchanged. Shared receipt SELECT explicitly lists projected rejection columns and adds an optional bounded branch; the legacy default retains native fingerprint/receipt behavior. Existing concurrency, restore and migration tests pass. |
| Browser boundary | An actual authenticated scoped browser explicitly checks the endpoint. The existing 390px coverage reader, Aden midnight label, hidden invoice projection and stale/revoked read behavior stay covered. No new status UI or decision editor is claimed in this server slice. |

The causal actual-build witness returned GET 200 but PUT **401 instead of 200** for the scoped account. The old coverage route is byte-identical between that frozen slice59 build and this slice's base `3acfee5d`.

Focused checks: **35 PostgreSQL cases in four files** (26 new status cases plus existing concurrency/restore/migration), **45 unit/guard cases in six files**, final build **`kjAZTJfRtOflAgY_0Na6p`** with typecheck, and targeted lint with zero errors/warnings. An earlier expanded typecheck exposed synthetic test query-facade and literal-string typing errors; those test declarations were corrected without product changes.

Built HTTP/Chromium passed **19/19 in two files**. The first run passed 15 and failed four invariant comparisons because login audit events occurred after the fixtures' baseline. Login now precedes each baseline; the full audit equality remains, with no event filtering or removed assertion. All four original failures and the corrected run are retained. The prior blanket owner PUT401 assertion was replaced by strict owner malformed-body400 plus a valid exact request from an adjacent actor requiring403 and unchanged effects; POST stays401.

Full final-source unit/PostgreSQL suites are running; runtime evidence and exact-head CI/independent review remain separate. This adds one source-converted method, bringing the local ordinary map to **79 canonical-done / 265 existing**, not a whole-program completion percentage. Inventory is NOT_READY. Actual Docker is blocked; existing image CI jobs admit older named branches and offer no dispatch for WORK. No alternative source, branch or network-policy bypass was attempted. No main merge, deployment, live data/settings or independent Rx work.

[Manifest, source hashes and original evidence](evidence/work-ortho-coverage-status-20261101/manifest.json).
