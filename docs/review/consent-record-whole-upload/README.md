# Consent record kept whole on upload (port of `6d10ed2` onto `main`)

## Why this exists
PR #291 (consent reprint integrity) merged at 2026-10-10 04:05Z from head `b54ce447` (merge `d60d872d`).
The follow-up `6d10ed2` (Codex P1 on #291) was pushed to the same branch at 04:24Z, after the merge,
so it never reached `main`. `main` @ `2667b71f` still stores every document note as `rawNote.slice(0, 300)`.

`components/ConsentModal.tsx` saves the signature screen's record (`buildConsentNotePayload`, JSON) through
`POST /api/patients/[id]/documents`. Since #291 the reprint reads that record strictly (`parseStoredConsent`),
so a record cut at 300 characters is invalid JSON and the reprint is refused.

## Evidence on `main` (synthetic data only)
- `main-300-cut-probe.log`: every current template, self and guardian, runs through main's own
  `buildConsentNotePayload`, then the route's 300-character cut, then `parseStoredConsent`.
  - The records are 329–362 characters.
  - **10/10 freshly signed records are unreadable.**
- `http-red-on-main.log`: the built app at `main` with only the new tests added. The run needs the
  `CONSENT_RECORD_NOTE_LIMIT` constant the tests import, so it was added as an uncommitted scaffold;
  the route is unchanged. Result: **2 failed | 11 passed (13)**:
  - the stored note is the cut prefix, not what was sent;
  - a cut record is accepted with 201 instead of refused with 400.

## Change (cherry-pick `-x` of `6d10ed2`, applied cleanly)
The four touched files are byte-identical between `b54ce447` and `main`.

- `app/api/patients/[id]/documents/route.ts`: a structured consent record (`kind=consent`, JSON note) is
  stored whole up to `CONSENT_RECORD_NOTE_LIMIT` (8000). A record the strict reader cannot read, or one over
  the limit, gets 400 with an Arabic message before anything is written. Free-text notes and every other
  document keep the 300-character cut.
- `lib/consent-record.ts`: `CONSENT_RECORD_NOTE_LIMIT`.
- Tests: `__tests__/consent-record.test.ts`, `__tests__/security-http/consent-reprint-integrity.test.ts`.

## After the change
- `http-green-on-fix.log`: **13/13** on the built app. Each template, for self and guardian, goes through
  the real form record and the real route; the stored note equals what was sent, and the reprint is signed.
  Cut, incomplete and oversized records get 400 and nothing is written.
- Unit `consent-record.test.ts` 8/8. Typecheck and lint pass.

## Not in scope
- Consents already stored truncated on production are not repaired here; they stay refused for reprint,
  which is the #291 rule. Any repair needs the paper or scanned original and is an owner decision.
  No production data was read.
- No schema, migration, permission or reprint-rule change. `documents.note` is `TEXT`.
