# Visit workspace contract review — 2026-10-26

## Scope and cause

Reviewed `components/ClinicalVisit.tsx` at combined source `aa763c1205eea24255462aa89a7b3c1a3a20bf3d` against the previously pinned source at `9860093a`. This repair changes tests/documentation only: no component, route, database, financial or authorization logic changes.

Seven failures were stale source-contract assertions, not failing clinical runtime journeys. Five whole-handler hashes predated subsequent explicit lab-command and orthodontic entry work; the payload's old marker also assumed an unconditional object instead of the new assistant notes-only branch. The old sign-equivalence assertion incorrectly claimed documentary reset remained its only change. The catalog now additionally blocks pending lab work.

## Reviewed changes, not a blind rebaseline

| Boundary | Intentional change | Preserved authority / evidence |
| --- | --- | --- |
| `load` | Roster-verifies suggested doctor, does not fabricate a complaint for a return, parses saved explicit lab identity, resets retirement drafts only on accepted replacement. | Original owner/sequence checks, 401/403/404 retirement, expected patient/visit, signed status and data-shape admission are byte-identical. Existing same-owner draft retention remains. |
| `send` | Uses exclusive browser admission; validates explicit lab source; seals/replays exact body; validates terminal receipt and only acknowledges after canonical refresh. | Current owner, accepted-read owner, in-flight command, confirmed-sign guard and post-response owner/attempt checks retained. A pending command can only retry its sealed body, not create a replacement. |
| `sign` | Adds lab pending/role gates, lock-time owner recheck, exact lab source version, validated ortho interval/wire removal, explicit decision for unresolved coverage, and separates pre-POST lock failure from uncertain POST outcome. | Original response acceptance through checkout callback remains byte-identical, including result shape/identity validation, unknown-outcome handling, confirmed-owner latch, documentary reset, canonical reread and final owner/attempt check. |
| `payload` | Assistants send only notes; clinical roles may include explicit lab identity and retirements. | No expansion of assistant clinical authority. Existing server-bound work fields retain their meanings. |
| `addPlannedItem` | Adds clinical-role, accepted-read and pending-lab gates; copies independently parsed saved lab identity. | Original plan-owned session price/currency calculation is byte-identical. |
| Catalog | Adds `labCommand.blocked` to the existing busy/clinical-role gate. | One catalog, one worklist and existing tooth/plan callbacks remain. |

Relevant source history includes `24e7545e` (verified suggestions/return context), `ae9af35b` (validated ortho drafts and explicit wire removal), `d86607eb` / `d4577322` (explicit followup coverage and signed proof), and `37b1b072` (guarded explicit lab identity). Review included the real mutation hook and clinical route's patient/role checks; a second read-only reviewer independently found no concrete authority regression in these slices.

## Original bytes still pinned

These hashes were extracted independently from `9860093a`, then verified equal against the combined source; they were not regenerated from changed logic:

- Load admission through (excluding) `const nextNotes`: `2f56edc6ed3cd57d73e25b479d8eea788780d41beae6449d2bef3405cebbea33`.
- Sign response parsing through the `onSigned` call's closing line (2,525 characters / 2,591 UTF-8 bytes): `503f874329a4b8c340d4e918fdad65478c4b0a4b7773f71472dc7bfb6ce9296a`.
- Linked-plan pricing/currency calculation before constructing the draft's fields: `0cb9ec86483ed89c44b2887efd8c78ad19c4e09ce68784744f68e7ed2c4b63b2`.

Tests keep all five complete current boundaries pinned as well, and separately assert ordering of the current owner/read/role/lock preconditions before mutation, note-only assistant payload, post-response ownership checks and uncertain-sign handling. The documentary reset must still occur exactly once.

## Verification

- Before repair: `visit-workspace-contract.test.ts` **7 failed / 3 passed**.
- After repair: contract suite **13 passed**.
- Actual component/hook/route-boundary suites: **176 passed** across `clinical-visit-ownership`, `clinical-visit-lab-containment`, `clinical-visit-ortho-entry`, `clinical-lab-command-hook`, and `clinical-lab-patient-scope-route`.
- Those suites cover A→B→A / role retirement, captured handlers, duplicate commands, denied/malformed reads, unknown sign outcomes, failed canonical reread after accepted signature, documentary reset, exact lab replay, cross-tab admission, pending holds, assistant notes-only saves, validated ortho drafts and verified doctor suggestions.
- Peripheral services and authentication are stubbed where those suites specify; these are local runtime unit/contract results, not browser, network HTTP, PostgreSQL or Production verification.

Raw focused logs are saved outside the repository under `combined-batch-ci-20261026/visit-workspace-{red,green}.log` and `visit-authority-runtime.log` in the task workspace. Parent retains full combined build/CI release gates.


## 2026-10-27 addendum — localized save transport failure only

Reviewed `components/ClinicalVisit.tsx` at `970180b4722755f47c244eeee6493a07e66ca259` against `6c2f5a8`. The only component changes are the `clinicalSaveFailureMessage` import and replacing the existing current-owner-guarded save catch's error-message expression with that helper. Browser fetch `TypeError` failures now use the localized connection guidance; explicit `Error` validation/command-lock messages remain intact. This does not alter save acceptance, retries, ownership, locks, payloads, canonical reloads, or sign outcomes.

The complete prior `send` slice was independently extracted from `6c2f5a8` and hashes to the already recorded `c2e47037edac7e0e9b4fdf374b05a76830803bfb85fc7e1774b7e6e9c8cbb019`. The reviewed localized slice hashes to `42f400b505a7819daee0f87940273e85b234972b049b2c58cd9824ea94f6b3f4`. Replacing the single exact new guarded expression with the exact old guarded expression recovers the prior slice byte-for-byte. A new regression assertion requires that single occurrence and independently recorded old hash; the complete current slice remains pinned. All other complete-handler, original load admission, sign acceptance, linked-plan price, and authority-order pins are unchanged.

Regression evidence: the parent reported the combined unit run at `970180b` had 777 passing files and 13,119 passing tests, with only the stale complete-`send` hash assertion failing. The focused helper tests cover browser transport errors, unknown failures and preservation of actionable validation errors. The earlier focused helper/fixture run passed 16 tests and full type checking passed. These are local unit/type results, not browser, PostgreSQL, hosted CI or Production verification. This addendum's assertion change still requires the parent's independent diff review and sanitized unit rerun; no test result is inferred from updating a pin.
