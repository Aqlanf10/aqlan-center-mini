> Historical prototype record. Current local composition, registered schema and remaining gates are recorded in [the unified laboratory ledger](../LAB_UNIFIED_LOCAL_ACCEPTANCE_20261026.md). Do not treat the old acceptance counts as current-head evidence.

# Origin lab UI slice — local, not release approval

## Implemented
- Today Visit and manual invoice source rows explicitly enable independent stable intent/member UUIDs; incomplete provider/shade/roles remain draft data.
- New bridge membership requires explicit joining to a selected, unsaved bridge; display grouping never supplies clinical identity.
- Exact returned plan aliases retain immutable `labWork`; materialized `labWorkOrderId` opens the existing patient-scoped canonical prescription editor/preview instead of a second request.
- Invoice data is included before existing durable command sealing/reservation. Receipt acceptance verifies the sealed intent/member set, positive order IDs, and revision not older than the sealed expectation. Materialized command receipts return touched members only, not unrelated members of the persisted bridge.
- Clinical saves seal body once in memory. IndexedDB stores only actor/patient/visit scope plus request key/hash/revision, never notes, prescription text, source tuple, or full request body.
- Lost response: same-session retry replays exact body. Reload: authenticated key+hash reconciliation can prove committed result and reload the authoritative DTO. Missing body + not-found remains blocked, with no new operation identity.
- Terminal server rejection is accepted only with exact authenticated receipt and successful authoritative DTO refresh, then reference ACK. HTTP status alone never clears an operation. Local full structural normalization runs before reference reservation.
- Web Locks serialize same-origin/principal/visit admission, fresh journal read, reservation, POST and outcome refresh/ACK across tabs. Ordinary save/sign/addendum and walk-in open/link actions participate. Source `labSignVersion` is echoed unchanged at signing for the server cross-device fence.
- Pending operation disables clinical form/sign controls. Actor/visit ownership retirement fences async callbacks. Missing capability fails closed. Reception never receives new clinical controls.

## Automated local evidence
- Focused 8 suites / 210 tests passed in `/tmp/lab-origin-ui-reviewed.log`: shared fields, receipt/reference pure state, actual hook harness, adjacent visit ownership/draft/ortho/lab and invoice readiness.
- Additional critical 3-suite / 61-test run passes in `/tmp/lab-origin-ui-critical-final.log`, including actual component pending+failed capability+no server intent, assistant notes-only, role-downgrade assistant hold, and rejection refresh failure/success ACK order.
- Coordination follow-up: 5 suites / 164 tests passed in `/tmp/lab-origin-ui-locks2.log`, including stale-empty tab B blocked after tab A reserves, and tab B sign/network exclusive lock blocking A reservation until release. Legacy harness timing was updated to await asynchronous admission while keeping synchronous double-click latch checks.
- Hook cases cover sealed retry, changed caller body, reload missing body, not-found lock, exact receipt scope, retired owner/unmount.
- ESLint own components/helpers: 0 errors; 2 existing warnings, `/tmp/lab-origin-ui-lint2.log`.
- First integrated typecheck exhausted default 2 GB heap. After backend owners fixed diagnostics, final integrated 4 GB `tsc --noEmit` exited 0 with no diagnostics: `/tmp/lab-origin-ui-types-final.log`.

## Explicit release gates/limitations
- No browser/real IndexedDB/viewport or PDF evidence from this slice. Hook harness and static render are not browser evidence.
- Template-generated invoice-site lab capture is not enabled; manual rows only.
- Joining additional members into persisted/materialized groups is not offered. Existing exact requests use their canonical editor; no identity repurposing.
- New incomplete prescription still requires a valid due date under shared contract; initial field uses clinic-local today and is visible/editable.
- Post-reload uncertain, not-found commands intentionally cannot be edited/recreated until a durable applied/rejected receipt is proven. Authenticated definite rejection permits correction only after authoritative reload. No clinical-note browser journal was added.
- Journal discovery runs for authorized clinical-note actors (including assistants)/patient/visit independently of capability; unavailable IndexedDB cannot prove absence of pending work and therefore intentionally blocks ordinary clinical-note writes too. Assistant saves omit procedures and lab command fields once absence of pending work is proven; role downgrade cannot bypass same-actor pending hold, and reconciliation/intent-bearing signing remain clinician-only.
- Web Locks unavailable: explicit lab/capable/unknown workflows fail closed. Only explicitly schema-absent, freshly known-empty legacy ordinary actions (and no-patient legacy walk-ins) may retain legacy operation; no fallback clears pending references. Web Locks tests use deterministic two-instance mocks, not hosted real-browser proof.
- Full architect source-identity acceptance matrix, database concurrency, hosted functional/browser evidence and combined review remain mandatory before publication.
