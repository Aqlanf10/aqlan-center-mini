# Saved-study capture context — 2026-11-10

This follows the independent export-permission slice at `78c9f76f` on `feat/ortho-reconcile-20261109`. It improves historical review and presentation; it does not implement treatment reopening or durable exported-file archives.

## Existing data and concrete gap

Every saved study already contains immutable `capturedAt` and `caseStatusAtCapture`. Documenting a draft later preserves its saved content and hash. The narrow editor response and rendered study did not display that lifecycle context. Consequently, a study captured during active treatment could be reviewed after case completion without showing when its facts were captured.

## Change

- Project the two saved fields through the strict editor response and validate both. Missing, invalid or noncanonical values are rejected; today's case state is never substituted.
- Show the saved capture status and UTC timestamp in the Arabic/English saved-study review, separately from revision creation/documentation time.
- Add one capture-context page to full text/illustrated presentations. Panel-only projection omits it, so illustrated page assembly does not duplicate it. Empty panel selection remains refused.
- Advance display renderer identities to v7. Persisted capture schemas, source hashes, template versions and saved content remain unchanged.
- Preserve existing patient/source/image/export authorization. These metadata do not grant access or change clinical, appointment or financial state.

## Evidence and remaining checks

Fixtures are synthetic and PostgreSQL18.6 is local and isolated.

- Real PostgreSQL journey:2/2 passed for completed and discontinued cases. Save during active treatment → close through the existing authority/guard → read/export the old revision → document that draft after closure → save a new closed-case draft. The old context/content/hash remain identical; the new capture reflects the terminal status. Subsequent study operations leave closure fields, financial counts, appointments and visits unchanged.
- Independent read-only review found no additional actionable defect in immutable projection, strict validation, source authorization or text/illustrated page assembly. This was not an independent execution of the test suite.
- Targeted units initially passed568 with one previous assertion expecting a source key on every presentation page; the capture-context page correctly has none. That assertion now checks the context page separately and retains exact source keys on every remaining page; its file passed11/11. Initial failure evidence is preserved.
- Combined capture-context/export-permission/closure PostgreSQL regression passed31/31 in three files. Counts overlap prior permission tests and are not additive coverage claims.
- Built HTTP/browser/PDF passed12/12 in three files, including existing workup and prescription journeys. Screenshots at390px/1280px and rendered first PDF pages were visually inspected. Both text and illustrated modes produce exactly two physical pages for the short fixture, with the context on page1 and interview on page2. Local Chromium151 is supplemental; hosted Chromium153 remains required.
- The new PDF test first failed: text print produced two content pages plus an empty third. Extracted PDF text and computed styles confirmed the final forced page break. The text page now suppresses only its last break. The same evidence revealed reversed footer ISO timestamps/page counters in RTL extraction; explicit LTR isolation fixes both and the PDF test asserts their order. No page-count assertion was relaxed.
- Additional real HTTP role-downgrade cases passed2/2. An old administrator cookie becomes invalid after a role change (401); a fresh doctor/reception login retains ordinary allowed study reads but cannot export until explicitly granted. The initial test wrongly expected transparent cookie renewal; it was corrected to the existing invalidation contract, with no authentication change.
- The final production build passed including TypeScript (`qdvEldM4_CWDDIFW2yGlE`). The separate full TypeScript run before the final role/discovery test additions passed; a latest-file incremental check is recorded in the local resume state. Scoped lint passes with one existing review-component warning.
- A persistent Vitest discovery regression uses the real glob engine against original TS/TSX tests and generated standalone copies. It passes with the real configuration; an isolated negative control removing only the `.next` exclusion fails by rediscovering both copies. The originals are never suppressed.
- Full O01–O52 acceptance and hosted results on the final combined head remain outstanding.

The existing closure and reopening rules are unchanged. In particular, reopening a saved study/browser is distinct from reopening terminal treatment. No main merge, staging/production deployment, real-patient data change or PR-creation retry occurred.
