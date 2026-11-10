# Saved assessment, closure evidence and full-study print — 2026-11-10

Branch: `feat/ortho-reconcile-20261109`. This stage follows `c8340975a68e259118d13766b456cd4054fc1f45` and is verified through source `741e7fc55b3ef7032a842c77c71e14a46d8446cc`. No main merge, staging/production deployment, denied PR retry or real patient data change occurred. The whole O01–O52 acceptance matrix is not complete.

## Existing behavior and changes

The assessment already stored versioned observations, dates and provenance. Its saved view required reading expanded detail. The new compact view shows the exact complaint once, documentation-state counts per interview/extraoral/intraoral section, and expandable exact values and provenance. Unknown, unmeasured, absent and conflicting identities remain distinct. Changed/unavailable source warnings stay visible. The corrective review action is above history. No assessment parser, owner or write semantics changed.

The retention ledger already stored debond/device events. A read-only closure review now summarizes those verified events beside the existing retention panel and clearly separates legacy metadata, current device state and unknown dates. An explicit bounded authorized request may list case-bound debond-stage image metadata. It does not infer image completeness, device delivery, treatment success or closure readiness, and it does not alter the existing closure gate. Known ISO dates are isolated from RTL text.

The saved full-layout PPTX projection now has a bounded A4 landscape browser/PDF adapter. The existing illustrated preview link selects explicit `mode=full`; legacy text/illustrated modes remain available. It reuses saved revision/source authorization, verified image transformations and the existing clinic print shell. Long content uses explicit continuation pages without shrinking clinical text. Each page carries revision/capture/source evidence. Raw witness JSON and original image recipes are excluded from the print DTO. Current-source/session/export checks run after projection/settings/audit work and before releasing the view.

Readiness checks reject missing/failed images, failed/pending fonts, region overflow or invalid layout. Printing before readiness withholds clinical sheets, including direct print shortcuts. The print DTO and page count have explicit bounds. This is clinical-only output: free text, images and notes may identify the patient. It is not educational anonymization, a versioned clinic-identity snapshot or an archived PDF service.

## Behavioral evidence

All data/images are synthetic; Node22.23.3 and isolated PostgreSQL18.6 were used. Local browser is Chromium151, while hosted CI uses its bundled browser.

- Product build at `d1fe9b9a094c1ede2ce86c2ef5b202ba80fe61f7` passed, including full TypeScript. `741e7fc5` only adds a real image PDF acceptance test. A final incremental full TypeScript run at741 exited0.
- Actual built HTTP/browser/PDF acceptance at741: **20/20 tests in4 files**. This covers saved assessment at390/1280, current export authority/role downgrade, closure metadata at390/1280, archive operations and approved-crop PDF output. Log: `display-final-http.log`.
- The new real image test stores a synthetic red/blue source, saves an approved crop, archives the PPTX and opens the actual full-print route. Archived and inline PNG bytes/hashes match the approved crop and differ from the original; source bytes remain unchanged. Exact physical PDF page count, per-page provenance and footer are checked. A sampled blue patch inside the watermark footprint remains the known expected color. Root visually inspected the actual PDF raster and both saved-summary/closure390 screenshots.
- Earlier assembled scoped suites passed318 summary/print/route/artifact tests and177 closure/retention/reopen tests; these overlapping focused counts are not a full-suite total.
- Standalone full-print browser/PDF proof passed3 cases covering49 physical pages and refusal conditions. Representative layout and continuation pages were visually inspected. Hosted print config now includes this suite and only its exact synthetic artifact paths.
- Source reviews independently inspected clinical unknown/source handling and full-print authority/image/limits/readiness. No material finding was reported. They were static reviews; they do not replace runtime evidence or specialist clinical acceptance.

## Independent archive review requests

Both previously identified defects are fixed in the branch; their before/after evidence is in [archive safety review](2026-11-10-archive-safety-review.md).

At741, the two relevant PostgreSQL suites passed **10/10**: seven real lock/audit waits where a signed cookie expires, and three backup/restore cases including a PPTX omitted together with its manifest entry while SQL still references it. The expired operation rolls back; incomplete/coordinately replaced files cannot reach cutover readiness. Caller-supplied later expiry cannot extend the signed cookie. Log: `741-expiry-restore-pg.log`.

## Failures retained and limits

The earlier combined HTTP run atfa97 passed26/29. Three synthetic marker assertions failed because a complete identifier wrapped across lines. The test now normalizes whitespace/bidi controls only for that exact marker and extracts visible print body content rather than hidden RSC payload. Exact clinical values and hashes remain checked. The affected10 export/PDF cases then passed; the subsequent741 batch above passed20/20.

The local full print gate passed **52/53**, with one existing lab-dispatch PDF failure. It first shows colon/token segmentation differences; deeper inspection also found a2.680499pt glyph-box overlap. The lab route/CSS/fixture/shared print CSS were unchanged fromc834, whose hosted print job passed. This does not prove browser version alone caused the failure. No geometry check, assertion or product layout was weakened. A separate uncommitted test-helper investigation is preserved and not integrated. Log: `display-final-print-gate-local.log`; diagnosis: `security-local-lab-print-diagnosis.txt`.

Full-unit and hosted results must be recorded against their own exact SHA. Earlier c834 quality passed18,193/18,193 tests in1,026files and hosted print passed; those results do not certify this later stage. The frozen741 full-unit run then passed **18,252/18,252 tests in1,032/1,032 files**, exit0 in789.48s; logs: `full-unit-741e7fc5.log/json/exit`. It predates the subsequent date-direction and reception-privacy changes. Later hosted heads require their own results.

The unavailable `b2d1d771049b716f2e2e1858b15fac4ad541140c` patch remains unapplied. The Windows uncommitted work and previous worktrees/backups remain preserved. Other remaining gaps include explicit retention instruction resolution, device-to-lab binding, full historical clinical import, educational anonymization, unsupported unverified cast methods, full finance/currency and reception checkout acceptance, versioned clinic identity, and the second Office viewer. No whole-unit or staging-ready claim is made.

## Subsequent isolated acceptance

The saved assessment heading had one remaining unisolated ISO date visible in the390px screenshot. Source6c4525a1 wraps the unchanged date in LTR isolation; its regression failed before and28/28 focused tests passed after. Integrated as24eaf8e4. The root real-browser date assertion is40f5b9b7 and awaits the next build.

O46 now has a bounded real reception journey in source327f2dc4 plus3f4b7011, integrated as5d496b87/739d32ff. The actual standard HTTP harness passed1/1 against the known d1 product build using identical741 migrations. Arrival dismissal and audited signed-visit deferral remain distinct; neither changes money. A90000YER opening balance with30000 per-visit arrangement is collected once, leaving60000 and due-now0. Exact-key payment replay retains one receipt, repeat physician signature is409, and no invoice or new obligation appears. Doctor setup/signing and retry use real HTTP; arrival/account/checkout interactions use the browser. The initial isolated setup failed EEXIST before any database/test work because of a static-directory symlink; the corrected exact known static assets/harness run passed. This does not certify foreign-currency or other O46 variants. Logs: `o46-http-327f2dc4.log`, `o46-http-327f2dc4-r2.log`.

That journey exposed a separate privacy-policy gap: current reception can read full clinical assessments despite write denial. A contained security fix is being developed separately; no whole reception-clinical isolation claim is made here.
