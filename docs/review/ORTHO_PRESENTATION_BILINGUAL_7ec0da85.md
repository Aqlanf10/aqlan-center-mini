# Independent bilingual study presentation — local review

Code checkpoint: `7ec0da858713a4ec4f2fa1e8709dd7eea6a65277`.
Tree: `7506ca0ad44da773e405e346e773f1aaf8dad880`.
Base: `9a25888b9312dcb148d9d9c1e52823c19d3897da`.
Branch: `local/ortho-presentation-only-20261012`.

The owner deferred financial overlap on 2026-10-12. This successor owns only
`components/OrthoCaseStudy.tsx`, `components/OrthoSavedStudyReview.tsx`,
`lib/ortho-case-presentation-i18n.ts`, its unit test and the existing independent
study React browser test. No database, financial writer, clinical writer,
authorization, schema, migration, case origin, invoice/payment/plan linkage or
clinical/template hash was changed. The underlying financial candidate remains
subject to root review; branch ancestry is not financial acceptance.

The mounted study editor now selects Arabic/English display language, preserves
the Arabic default, changes RTL/LTR, and names sections, source types, controls,
missing data, revisions, read failures and uncertain save outcomes in the chosen
language. A browser preference stores only `ar` or `en`. It is not a clinical
field and is absent from save commands. Patient names and authored clinical text
remain verbatim; text inputs and saved prose use automatic text direction.
Saved source blocks remain in their recorded language and are explicitly labeled
as such. The existing layout titles are read without modifying their registry.

This is partial evidence for requirement `V2R129`, whose source remains in
`docs/ORTHO_CEPH_REQUIREMENTS_LEDGER.json`. It does not accept O01/O04/O05/O38/O50/O51
or any full scenario. All 349 requirements and 52 acceptance scenarios remain
retained. Interview/examination forms, calculations, image editor, mount failures,
structured source block captions and export locale still require wider bilingual
work. This packet does not claim complete app localization or case export.

Verification on this code:

- `unit-bilingual-verified.txt`: 3 files, 34 tests pass (language, study owner,
  saved review contract). No tests disabled.
- `native-bilingual-verified.txt`: 13 independent React tests pass in native
  Chromium, including Arabic/English at 390 and 1280. Real React and CSS are used;
  clinical transport is explicitly synthetic. This is not a built application / PG
  journey claim. Two new cases verify retained authored text, unchanged read owner,
  same command bytes after lost acknowledgement, one saved revision, unchanged
  state on language switches, and no horizontal overflow.
- `typecheck-bilingual-second.txt`: TypeScript exits 0.
- `lint-bilingual-final.txt`: no errors; the existing SourcePicker dependency
  warning is retained, not suppressed.
- `build-bilingual-final.txt`: ordinary `npm run build` / Turbopack exits 0. An initial
  external node_modules symlink was refused by Turbopack. A Webpack attempt failed
  on the existing portal `node:crypto` dependency; no unrelated source/config was
  changed. Dependencies were copied locally before the ordinary build retry.

Synthetic screenshots were produced for both languages at both widths. English
390 and Arabic 1280 pixels were inspected. The screenshots contain no original
reference or real clinical data. They are component evidence, not reference
template fidelity or native PowerPoint/LibreOffice evidence.

The previous uncommitted Ceph science packet is frozen separately under
`/workspace/ortho-union/frozen-ceph-20261012`: eight files and their SHA256 values,
plus a tracked diff, based on 9a25888b. Its shared `lib/db.ts` work was not imported
into this branch. It has five audited-write fixes, new method identities and
sealed-value projections, but creation-audit rollback still fails and a historical
label browser test still fails. It must not be presented as complete or merged
without root coordination. Later migration reservations are 0052–0055 Ortho,
0056–0058 HR and 0059 invoice debt installments. The older test-only periodontal
0058 suffix now needs coordination; this packet does not renumber or run it.

The exact historical successor `dc465fba..9a25888b` was separately supplied as a
three-file patch, 33 insertions / 13 deletions, with raw red/green PG evidence:
`libfile_b49e8674dd488191ae0bbc7e1ce4d073` (patch),
`libfile_15720d42337881919f0dbd4413973caa` (corrected evidence),
`libfile_49299f568fc481918c9ab523322331ef` (78 passed),
`libfile_a84135c299f4819189318421f3f2596a` (prior failing test).
The previous 16 browser and 139 guard counts are not new tests of this successor.

Original-reference access was retried once through the supported per-file route
after confirming these exact Library identities. No prior per-file error is
invented: earlier failed transfers concerned the source archive / owner ZIP.
On 2026-10-12 `Library.prepare_materialize` returned a signed GET with no local
workspace path for each file. The provided Library transfer helper returned exit
1 and `library file transfer failed: download failed` for all three; no HTTP status
was exposed and no local bytes/hash could be verified:

| Reference identity | Additional page-read result |
| --- | --- |
| `libfile_8575ec1151808191a7c9e043f84f1c92` | Page 1 returned image asset pointers, not model-visible image bytes. |
| `libfile_4eb348f84db88191a8ad7ec9ada807cd` | Page 1: rendered page images unavailable; no readable content for requested image mode. |
| `libfile_77c9bec1d5608191abf78587599d4832` | Page 1 returned image asset pointers, not model-visible image bytes. |

Raw transfer outcomes: `libfile_4c5492bc4a048191975d92b00dec2f9f`. Signed URLs are
kept out of the report. No retry after this failure, guessed download link,
reference screenshot, original pixel inspection or layout fidelity is claimed.
Original editable PPTX / matched PDF work remains gated on reference inspection.

No push, PR mutation, main merge, deployment or live patient operation was made.
