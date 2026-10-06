# Recall mutation refusal visibility

## Bounded defect

Audited against main `ea312ad872897b07ad2241c09084837dee355dae`.

In `app/recall/page.tsx`, both `closeOpenPast` and `markDone` set the
server refusal message on a non-success response and then unconditionally call
`load`. A successful refresh sets the shared error to null. The refusal is
therefore replaced by an ordinary-looking refreshed list, even though the
command was not confirmed successful.

Source anchors on the audited main:

- Page lines 65–78: the read helper clears the shared error after a successful read
- Page lines 86–109: past-appointment completion/non-attendance handler
- Page lines 111–134: missed-appointment and lapsed-patient follow-up handler
- `app/api/recall/route.ts`: POST deliberately rejects unauthorized operators
  with 403, changed/missing records with 409, and operational failures with 500
- `app/api/appointments/[id]/route.ts` lines 149–160: existing
  `resolvePastBooking` refusal returns controlled 409

This is an independently bounded core reception repair under the live roadmap's
remaining workflow/operational acceptance. It does not complete the overall
reception or recall phase.

## Repair

Return immediately after recording a non-success response in either existing
handler. A narrowly separate mutation-error state owns command refusals and
transport errors, so an unrelated successful or failed read cannot erase them.
Starting an explicit new command clears only that mutation error; any existing
read failure remains visible until a successful read clears it. A current
mutation error takes display precedence over the read error.
Their existing `finally` clauses still release `inFlight` and `busy`.
Only a confirmed successful HTTP status invokes the existing canonical refresh.
There is no optimistic row removal, fabricated success, automatic retry or new
write path.

The same status-only success behavior is retained: an unreadable success JSON
body still leads to a read, while an unreadable refusal body uses the existing
localized fallback. A successful write followed by a failed read shows the read
error and retains the last loaded rows; it does not replay the write.

No API, database, schema, permission, audit, appointment state-transition,
contact-template, financial, clinical or patient-data behavior is changed.
The common `PrintButton`, daily-report page, plan/signing/orthodontic files,
security locks and periodontal work are outside this slice.

## Candidate verification

`__tests__/recall-mutation-refusal.test.tsx` contains 68 proposed controlled
component-handler cases across the four actual page commands:

- Close an old appointment as done
- Close an old appointment as no-show
- Mark a missed appointment followed up
- Mark a lapsed patient recalled

For each command, test:

1. HTTP 401, 403, 409 and 500 refusal remains visible; no success refresh, no
   invented empty state, exact original method/URL/body
2. Undecodable refusal uses the existing localized fallback
3. Transport failure remains visible without an automatic read or write retry
4. Confirmed success refreshes and uses the returned canonical list
5. Explicit retry after refusal can succeed and clear the old error
6. Synchronous repeated and cross-command submissions stay behind the shared
   existing lock, which is released after refusal
7. Failed refresh after success remains an error without replaying the write
8. Undecodable success body retains established status-only readback behavior
9. Delayed unrelated GET success/failure after a command refusal or transport
   failure cannot erase it
10. An explicit retry clears only its own error, preserving a separate read error
    until the retry's canonical successful read
11. Duplicate commands remain locked during the successful write's pending
    canonical refresh, then the lock releases

The harness executes the actual page handlers and effects with synthetic fetch
responses and stubbed peripheral components. It follows existing repository
component-test conventions. It is not a real-React scheduling, PostgreSQL,
server/API authorization or built-browser test.

At preparation time, these cases, typecheck, lint and all runtime gates are
NOT RUN. No installation, local server, build, local database or Production
operation was performed. The original page is retained separately for a
controlled desired-red counterfactual before accepting the candidate.

## Release acceptance still required

- Independent source review of the exact candidate and declared boundary
- Controlled original-source counterfactual for refusal assertions, then full
  focused cases on the candidate; preserve genuine positive controls
- Exact-head CI, including full types/lint/unit/PostgreSQL/security/HTTP and
  existing operational journeys, without weakening any gate
- Built 390px and 1280px RTL page refusal/retry checks, with synthetic data only,
  confirming the alert is readable and the original command is available again
- Review any fresh allowlisted visual artifact on the exact tested source
- Normal no-review-blocker release, exact Railway Production commit/native
  health verification, and only authorized read-only live checks

## Explicit remaining limits

This small repair stops a refused command from starting its own success refresh
and separates command errors from existing read state. It does not add
whole-page request/result lifetime ownership, principal-change containment or
durable unknown-outcome recovery. Existing filter-read result races remain a
separate issue.

The initial-load failure path can still show zero counters and empty-list
completion language. That is a distinct existing display-state defect, not
silently counted fixed here. Recall read staleness and initial unavailable-state
truthfulness should receive a separate bounded slice or explicit scope extension.
