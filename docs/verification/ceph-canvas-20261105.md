# Cephalometric drawing and formula repair

Base: Mini main `c6c886121bcc50aa548f64b0b0fbd7b5beb1f324`.
This change is prepared for isolated staging review. It does not authorize a main merge or Production deployment.

## Scope

- Recover native image dimensions from cached/SSR images even when the load event precedes hydration.
- Give digitization the available workspace width; fit the image, then zoom/pan without changing stored coordinates.
- Render the same image, filters, privacy mask, saved/live calibration and existing guide/landmark geometry inside the loupe. Show it anywhere on the image, outside RTL/transformed ancestors.
- Support mouse and touch placement/drag, explicit panning and pinch zoom. Suppress unintended placement after dragging or a gesture.
- Order manual edits, undo/redo and calibration writes. Undo removals are guarded and durable. Failed edits remain pending; conflicts do not overwrite another session. An explicit confirmed reload can abandon local pending edits.
- Integrate the separately reviewed numerical fixes documented in `docs/ceph-formula-conventions.md`. Historical sealed values remain stored and are not recomputed. EXT_INDEX is withheld from current displays, reports, API readers and comparisons pending clinical-definition validation. Lines remain landmark-based guides, not anatomical contour tracing or new AI capabilities.

## Automated checks

On the required Node22 runtime, 181 focused formula/queue/API/presentation regressions and 11 real PGlite transaction tests passed in the integrated candidate. Focused frontend typecheck and changed-file lint passed (pre-existing unused-variable warnings remain). Backend and numerical regressions were observed failing against the baseline before the repair. These counts are not clinical certification.

`__tests__/security-http/ceph-tracer-real-react.test.ts` exercises the actual React component with real Tailwind and synthetic colored image pixels. The fixture intercepts all writes and never uses real patient data. It covers hydration, RTL positioning, loupe screenshot colors and filters, guides/calibration parity, responsive layout, native-coordinate writes, zoom/pan/resize, mouse and touch drag, pinch, undo/redo/reload and failed-save retry.

Standalone command:

    PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npx vitest run --config vitest.ceph-browser.config.ts

For baseline comparison, set `CEPH_BASELINE=1`; the adapter reads the original component at the base commit above. These browser tests are also discovered by the existing security-HTTP CI configuration.

The implementation workspace could build the fixtures but could not launch Chromium because its UNIX sockets were restricted. Browser baseline/candidate assertions therefore remain unverified locally. The isolated real PGlite transaction fixture passed 11 tests in independent review (all 11 failed against baseline). It exercises extracted production functions and a minimal schema, not whole-app bootstrap. Whole-repository typecheck/full-unit attempts were resource-killed or blocked by temporary-filesystem exhaustion, not passed. Hosted CI and actual staging browser acceptance must complete before user trial.

## Staging acceptance

Use an isolated synthetic study only. Confirm cold load, preloaded reload, reopen, and narrow/mobile layouts. Place known native image coordinates at fit and after zoom, pan, resize and pinch; ensure the same coordinates survive reopen. Drag one point, undo a placement, redo it, and check the saved record. Exercise calibration and a save failure/retry. Verify a conflicting second editor is reported rather than overwritten, and that the confirmed reload escape works. Confirm a completed study cannot be modified.

Clinical measurement accuracy requires separate synthetic ground-truth validation and clinician review. UI pixel alignment alone is not evidence that every cephalometric formula or clinical reference is correct.
