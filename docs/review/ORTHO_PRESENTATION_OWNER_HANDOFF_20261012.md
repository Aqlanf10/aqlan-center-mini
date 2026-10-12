# Owner handoff — presentation only, WIP

Stopped on the owner's credit-preservation instruction. No further development,
release approval or full-tree acceptance is claimed.

- Preserved reviewed base: `4fcc75e55bdee1ab96d206674b1d5cf9b7aae48b`, tree
  `40cbd585f077aae78610b4e9bfa405baad400d96`, separate branch
  `handoff/ortho-presentation-reviewed-20261012`.
- New code checkpoint: `ee78548d7c76598de1404fd81ac8aa78551946af`, tree
  `810a5012a454ac3cbfc9ca7f8f24533469941098`.
- This handoff is a documentation-only successor on
  `handoff/ortho-presentation-wip-20261012`. Resolve its actual head/tree with
  `git rev-parse HEAD HEAD^{tree}`; the delivery response verifies remote SHA.

Seven changed code/test files, 187 insertions / 24 deletions. Display-only source
reason translations recognize eight existing reader codes. Unknown reasons retain
an escaped literal code and a localized unknown-description message. Clinical
prose is never run through this translation map. Saved table headers use automatic
direction. Authored fields, patient names and saved prose/cells explicitly use
unknown language (`lang=""`) because the current contract contains no authored
language metadata. Labels retain UI language through separate aria-labelledby
targets. The still-Arabic image editor is marked `lang="ar"`.

The HTML language semantics follow
[HTML Standard](https://html.spec.whatwg.org/multipage/dom.html#the-lang-and-xml:lang-attributes):
unknown language is not inferred from script or UI locale. DOM/computed direction
was tested; no screen-reader speech-session acceptance is claimed.

Actual verification, with raw logs retained locally under `/workspace/ortho-union`:

- `unit-reasons.txt`: 35 passed in three files; 34 previous plus one new source-code
  allowlist/unknown-input case. No broad clinical acceptance is implied.
- `native-reasons-final.txt`: 15 passed in native Chromium, 12.20 seconds.
  Exactly two new populated cases at 390/1280, plus the previous 13 cases.
  Real React/CSS, synthetic existing GET envelopes; no actual HTTP server or PG.
- The two new cases preserve all displayed cells, stored source/calculation
  identities/hashes, authored text, image recipe/caption and draft bytes; verify
  Arabic/English switching, header direction, escaped unknown code, unavailable
  source selection, disabled writing and zero POST requests. Hard reload rebuilds
  the deterministic synthetic server response; only displayLocale is persisted
  in browser storage. This is NOT real clinical persistence evidence.
- Eight new full-page PNG/JSON observations were generated and all eight pixels
  inspected. Long table content uses the existing local horizontal scroller;
  document width stays within the viewport. These are synthetic presentation
  screenshots, not original reference fidelity or actual image previews.
- TypeScript passed; targeted lint passed with two retained warnings (SourcePicker
  effect dependency and an existing unused image-rule suppression). No suppression
  or test was disabled. No unrelated build, PG, HR or finance rerun was performed.
- Earlier browser attempts: missing default browser executable; interrupted
  selectors; then 13 passed / 2 new selector timeouts. Native accessible combobox
  selection fixed the test selector; final 15 pass. No timeout was increased.

The diff does not change db.ts, shared/clinical/financial writers, plans, APIs,
permissions, migrations, bootstrap, calculation definitions or template identity.
Previous 7ec0da85/4fcc75e5 review was narrow (five files plus docs); neither that
review nor this packet clears the underlying financial ancestry or whole tree.

Remaining: current mount does not provide requestImagePreview; saved-review API
provides pendingMediaCount only. Populated media tests therefore prove recipe
retention and explicit preview unavailability, not functioning preview/image
editing or image persistence. Original reference fidelity, editable PPTX, PDF,
real persistence/DB journey and frozen Ceph remain uncleared. Requirement V2R129
is only partially supported; no one of the 52 full scenarios is accepted here.

Migration reservations: 0044 discount; existing 0045–0051 immutable; 0052–0054
Ortho study foundation; 0055 clinical governance (source absent from PR324, must
be supplied by owner); 0056–0058 separate HR; 0059 invoice debt installments.
Old test-only periodontal 0058 conflicts and requires root coordination. No
placeholder, renumbering, SQL execution or guard weakening occurred here.

Next exact step for root: review `4fcc75e5..ee78548d` (seven files), especially
language semantics and the full synthetic fixture. Decide preview-reader ownership
before wiring any image callback; keep shared writer/DB/finance work outside this
branch. Frozen Ceph is separately preserved on
`handoff/ortho-ceph-frozen-incomplete-20261012` and must not be imported wholesale.
Owner authorized only handoff branch pushes; no main merge or deployment.
