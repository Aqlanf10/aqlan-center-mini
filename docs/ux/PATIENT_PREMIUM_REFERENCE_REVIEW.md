# Patient reference implementation — review handoff

Branch: `codex/patient-reference-fidelity-20261014` · Draft PR [#330](https://github.com/Aqlanf10/aqlan-center-mini/pull/330).

The approved base is **`175957f4e074d28b819d00a51f3f1e6d53b3d78b`**, on `staging/patient-premium-on-invoice-20261014`, not main. Its invoice parent is `03d325a8b6511098237458c38444620db59709e7`. The first UI checkpoint is `4538f57bb0171ee8d4b9428316633b331e024c0b`. This branch depends on that integration base; it must not be substituted for another staging source without integration review.

## What changed in the real application

- Patient-scoped blue gradient sidebar, official clinic header, patient identity and five main tabs. Existing routes and role-filtered navigation remain reachable, including less frequent destinations in the sidebar disclosure.
- Summary: actual metrics, separate currency selection, independent plan selection/progress, clinical context and next actions. Personal and medical views use the existing patient record and mounted editors. Critical warnings and chair/readiness controls remain visible.
- Account: read-only agreement/due metrics, separate native currencies and CSS composition of the original ledger's balance/actions/plan disclosure and invoice/receipt regions. No additional invoice, receipt, debt, allocation or payment writer.
- Files: one category-filtered document list, one selected image/PDF preview and the original uploader. The duplicate legacy gallery was removed. Download, patient photo, consent print, comparison and audited hiding act on the selected record through their original handlers; admins can review hidden records and the recorded reason. Native full-screen preview retains keyboard focus and explicit load/error/retry feedback. The synthetic fixture is explicitly labelled as non-diagnostic.
- Treatment: the canonical odontogram in a three-column workspace, selectable plan context, case/problem cards, plan cards, endodontic regions and existing orthodontic controls. Lab, referrals and materials retain their original forms and writers in responsive card layouts.
- Medical history: three cards for recorded history, vitals and safety, an immutable version list and the real questionnaire in a keyboard-contained native modal. Missing facts remain unknown. A failed save retains the draft.
- Cephalometry: the signed study's own source image, stage/author/calibration and stamped ANB/FMA/Wits values. Existing scope selection, study links, stage history and comparison controls remain canonical. No invented diagnosis or measurement.
- Navigation guards now include upload, materials, referrals, email, patient editing and questionnaire drafts. The guards register with the existing patient navigation controller and are retired with their owner. Busy forms cannot be discarded.
- The global booking-request badge is read only for admin/reception, matching its server permission. Doctor tests assert that the forbidden badge request is absent while the server still denies unrelated patient/document access.

No changes to `lib`, API routes, migrations, financial writers, dependency manifests/lockfiles or CI rules. No migration number was selected. No staging or production service was changed.

## Button placement and duplication review

Primary actions remain beside their task and secondary actions stay grouped by context. Patient-file navigation uses the same five destinations; long clinical workflows keep their native controls and disclosure hierarchy. In Files, preview/download controls are followed by the selected document's actions. Hiding is visually distinct and still requires a reason; it is not placed beside the upload submit button. Core patient action controls have 44px mobile targets, with visible keyboard focus. Clinical tooth geometry is deliberately excluded from broad button resizing.

The browser suite asserts one document gallery, one item per uploaded record and one selected action group. It uploads using the real form, switches file/camera input, verifies the image, hides the synthetic record, reviews its reason through the admin-only category, and verifies the retained database row. Summary and Account use the same read-only financial metrics component in mutually exclusive tabs; the original PatientLedger remains the only account workspace. No second financial writer, routing shell or data model was introduced.

## Review evidence

The [portable screenshot gallery](evidence/final/index.html), its [manifest](evidence/final/manifest.json), and the [inline comparison table](evidence/final/README.md) contain 15 supplied references, 45 actual viewport screenshots and 45 full-page captures at **1448 / 1280 / 390**, 12 additional detail captures of long clinical sections, and 15 pixel-difference maps. The manifest includes SHA-256 hashes and raw comparison results. Download the HTML and adjacent files to use its width selector; GitHub also displays the PNGs directly.

[The first checkpoint](PATIENT_PREMIUM_PHASE1_REVIEW.md) retains before/after evidence for Summary and Account. These are actual built-app captures, not a replacement interface, injected CSS or mocked API data. The new visual suite uses isolated PostgreSQL 18 and synthetic accounts/records; uploads, history versions, referral and stock-consumption fixtures use the actual HTTP writers. Cephalometric signed geometry is an explicitly synthetic database fixture; this test does not claim a browser tracing/signing journey.

## Repair after the failed 2d1c9cb2 head

The [CI repair report](PATIENT_PREMIUM_CI_330_REPAIR.md) identifies the two pending-note failures, exact expected/actual results, local reproduction and scoped fix. The current refinement also deduplicates only an exact patient warning already visible through its independently authorized record; readiness denial and history-warning ownership remain unchanged.

The visit-stage disclosure now shares the action row. In the severe-allergy synthetic fixture, the first patient tab moved upward by **33.5px at 1448/1280** and **15px at 390**, with complete warnings and larger mobile targets. The Summary full page shortened from 2751 to 2292px at 1448, and from 4922 to 4486px at 390. These are measured layout changes, not reference-match scores.

Plan progress is linear and based on recorded procedures. One collection action remains in Summary's account region. Currency detail disclosures preserve every existing financial value. Account uses the original balance, actions, treatment details and historical preview; expanded forms receive full width. No duplicate writer was added. Patient orange buttons use dark text for readability.

After correcting the warning composition, **79/79 tests across nine HTTP/browser files passed**: navigation/freshness, visit ownership, pending notes, workspace controls, More, invoice labels, cockpit/readiness and all 15 scenes. The final account/plan-layout rerun passed **58/58 cases across six files**, including historical preview and plan-payment authority. The exact-head CI result is recorded on PR #330. [Latest runner evidence](evidence/final/repair-verification-results.txt) includes the rejected intermediate warning composition, its repair and all final local checks. Historical checkpoints below are not substitutes for the final-head CI.

## Earlier verification checkpoints

[Actual runner excerpts](evidence/final/verification-results.txt) retain both the failed intermediate run and the successful reruns.

| Check | Result | What it establishes |
|---|---|---|
| Full unit suite | 9,179 passed / 514 files | Existing domain/component regressions; subsequently 22 focused ceph/treatment/account tests passed after the date-format adjustment |
| Final built-app acceptance run | 47 distinct cases passed across the final run and targeted rerun | All 15 scenes at all three widths; one document list; native upload/preview/audited hiding; 44px file controls; medical draft/save; roles; invoice settlement safety; navigation and More |
| Navigation, More, cockpit and visual rerun | 46/46 passed | Touch/keyboard RTL/LTR, discarded/refused drafts, real contract responses; both CI-only navigation cases enabled locally |
| Broader HTTP/browser coverage | 93 distinct cases passed across reruns | Invoice creation, double submission, preview authorization/uncertain acknowledgements, identity/history, ortho records, navigation and the new UI |
| Typecheck / optimized build | Passed | Compilation only; not a visual acceptance claim |
| ESLint | 0 errors, 185 existing warnings | No weakened lint rules |

The checkpoint CI on `4538f57b` failed ([run 38490753166](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38490753166)). Its four More-menu failures asserted the previous expanded-header design; these assertions now expect the approved disclosure while preserving dismissal/draft tests. The invoice-label edge hit test exposed an actual Arabic glyph overlap, fixed with scoped padding. The real-contract test read a response body after navigation disposal; it now reads that response eagerly. All affected suites passed locally without increasing deadlines or changing CI rules. A later cold account start raced `DOMContentLoaded`; the test now waits for the actual account tab to mount before retaining its original one-pending-read assertion, and the complete invoice-label suite was rerun. The final-head CI link and status are reported on PR #330; checkpoint results must not be treated as final-head results.

An earlier local HTTP run was invalidated after a build was started against its running `.next` output. The affected server was stopped, the disposable test database recreated by the harness, and the final build/browser runs serialized. That interrupted run is not counted as passing evidence.

## Visual differences and limits

The screenshots are not pixel-identical to the illustrative gallery. Raw pixel differences are diagnostic and **are not a percentage acceptance score**: blank backgrounds, different text and different fixture records affect that number.

- The operational patient header is still taller than the reference, after reducing spacing and duplicate text, because it retains complete critical warnings, chair state, readiness and the current visit action. The synthetic severe-allergy case deliberately exercises those warnings on every screen.
- Financial content comes from the native ledger. Currency tabs, canonical agreement disclosures, legacy/context notices and the available action cards differ from the gallery's static four-card account example. No second financial model was introduced to reproduce the drawing.
- The original odontogram, endodontic editor, orthodontic wire controls and appointment/clinical state machines remain recognizable. Their geometry and available clinical facts differ from the illustrative tooth images and populated static examples.
- Lab/referral/material forms reflow around their actual order/movement lists. Empty or unrecorded information is labelled instead of being filled with sample clinical facts.
- Only 1448px reference PNGs were supplied. The 1280/390 screenshots prove responsive layout and interaction, not comparison with a supplied mobile reference. Mobile stacks cards and retains the existing bottom navigation.
- Role-gated screens differ intentionally. The doctor sees no financial overview and receives the canonical account denial; reception/admin retain their authorized controls.

These distinctions need visual review; build success and test counts alone do not establish exact reference fidelity.

## Reproduction

Use the existing trusted local environment and a disposable PostgreSQL service. Build once, let it finish, then run the HTTP suite against that build. Do not rebuild `.next` while that harness is serving it.

```sh
npm run build
PATIENT_VISUAL_OUTPUT=/tmp/aqlan-patient-captures npm run test:security-http -- \
  __tests__/security-http/patient-premium-visual-ui.test.ts --reporter=verbose
node scripts/visual/patient-reference-report.mjs /path/to/extracted-references \
  /tmp/aqlan-patient-captures /tmp/aqlan-patient-review
```

Pure unit tests expect no inherited `DATABASE_ENVIRONMENT=test` classification for the unclassified-host safety cases; use `env -u DATABASE_ENVIRONMENT npm test`. This changes the test process environment, not the safety assertions. The longer runtime-tracing test was rerun without a concurrent lint/build load, without changing its 5-second deadline.

## Staging and tools

The stated staging URL is https://staging-web-staging-0d39.up.railway.app. Direct access is blocked by the current environment proxy; no deployed SHA or staging-browser result is claimed. The additive environment-network draft remains separate from an application deployment. Staging responsibility remains with dot.

React/Next, existing CSS/Tailwind components, Chromium/Playwright, Vitest and Playwright's bundled image comparator are used. Intelligent UI and skill-creator are not callable here; no untrusted plugin was installed and no use of either is claimed. The [repeatable workflow](AQLAN_REFERENCE_FIDELITY_WORKFLOW.md) is a repository guide, not a fabricated installed skill.

Browser coverage is Chromium at the three requested widths. Physical devices, Safari/Firefox, real camera capture, live external services, actual patient records and staging deployment remain untested.
