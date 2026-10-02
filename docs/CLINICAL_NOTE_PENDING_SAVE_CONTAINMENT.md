# Clinical notes during a pending save

## Confirmed race and bounded containment

`ClinicalVisit` captures the note/procedure snapshot when **Save without signing**
is clicked. Its existing `busy` interval includes the POST response body and the
subsequent `load()` request/body. Previously, all five note fields and quick
phrases remained editable during that interval. Synthetic tests demonstrated that
newer accepted text was then replaced by the older submitted snapshot on reload.
This is a local reproduction, not evidence of an actual Production incident.

The containment temporarily disables the five note textareas and their quick
phrase buttons. The note setter also rejects callbacks during `busy`. Procedure
changes can regenerate `treatmentDone`, so both existing procedure fieldsets and
their shared mutation callbacks are protected for the same interval. Planned and
free additions, quantity/tooth edits, and the currency-selection path therefore
cannot indirectly change the treatment note while the snapshot is in flight.

The lock ends when the existing operation finishes, including failed POSTs and
failed reloads. Failed saves retain the submitted local notes. There is no new
autosave, draft merge, storage layer, backend writer, or payload change. Existing
signed-read-only rules, role permissions, planned-price eligibility, financial
calculations, signing, and patient link/relink logic are unchanged.

## Scope boundaries

`busy` is shared with other existing operations, including signing, laboratory
requests and opening a patient file. Notes and procedure edits are also temporarily
frozen during those operations' existing busy intervals; their request/reload
semantics are unchanged. Review/back navigation is outside the disabled procedure
fieldsets. The lock does not remain after an operation finishes.

This is not general unsaved-draft recovery. It does not protect earlier unsaved
edits from unrelated reloads, visit changes, navigation, or closing the browser.
Doctor selection, orthodontic fields, addenda, and other application forms are
outside the note-loss repair. No historical clinical data is inspected or changed.

## Local regression evidence

`__tests__/clinical-visit-draft-preservation-audit.test.ts` executes the actual
component's state, effects and handlers through the repository's lightweight
hook-harness pattern. All network calls and peripheral components are mocked;
the fixture is an already-linked synthetic visit. No application route, database
bootstrap, authenticated browser, or real write is executed.

The 14 hook regressions cover POST/reload timing, slow JSON completion at both stages,
success/HTTP-error unlocking, retained notes after errors, native note/phrase disabled
props, guarded callbacks, generated treatment-note interactions, ordinary free
and planned procedure addition, signed-read-only behavior after unlocking, and
review/back without another save.

The focused command uses Node 22:

```sh
node node_modules/vitest/vitest.mjs run \
  __tests__/clinical-visit-draft-preservation-audit.test.ts \
  __tests__/clinical.test.ts \
  __tests__/visit-suggestions.test.ts \
  __tests__/patient-visit-plan-ux.test.ts
```

Focused TypeScript and ESLint checks pass; ESLint reports three pre-existing
warnings in `ClinicalVisit`. Full-repository lint/typecheck attempts were killed
with exit 137 in the local environment, so they are not claimed as passing. Full
checks and built-browser execution remain exact-commit CI gates before release.

## Built-browser CI coverage (authored; not run locally)

`__tests__/security-http/clinical-visit-pending-notes-ui.test.ts` adds five cases
using the existing isolated built-HTTP harness. Every browser API read and every
write is intercepted; unknown requests fail the fixture's assertions. The visit
is already linked, all data is synthetic, and no clinical save, signing, relinking,
inventory or financial request reaches the server.

The cases exercise actual native disabled behavior through held POST and GET
requests, successful unlock, HTTP/network POST failure and corrected retry,
failed-reload unlock, and generated treatment notes with an already-open tooth
picker. Note locators use the static label span followed by its textarea, avoiding
the changing controlled-textarea accessible name found during PR187 validation.

Only `.settings-ui-artifacts/clinical-visit-pending-notes.png` is explicitly
allowlisted for the new artifact. It captures the synthetic visit while locked.
The test file passed focused strict TypeScript and ESLint checks, but no local
browser or server was started. Its runtime result and screenshot must be reviewed
from exact-head CI before release.
