# Appointment follow-up fixture contracts

Independent test-only follow-up to #450 at `96bb3e2e132cc0fac677d2402abc58e302f3241b`.
The transferable Zod commit and the original #450 branch remain unchanged.

## Observed failures before the change

Exact-head run [40031633587](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/40031633587)
passed quality/audit/build/runtime and PostgreSQL/schema/ownership/operational/baseline,
but failed HTTP and the required aggregate. Check-run annotations (not downloaded raw
logs or artifacts) identified these first failures:

| Fixture / guard | First failure |
| --- | --- |
| `reception-signature-handoff-ui.test.ts`, `allowBuiltBoardRead`, assertions at original lines 167/243/295 | Unexpected `GET /api/appointment-followups?limit=25`; five cases |
| `clinical-visit-owner-ui.test.ts`, `fixture()`'s `context.route`, `expectSafe` at original line 263 | Expected `[]`, received `['GET /api/appointment-followups']`; four cases |
| `hr-temporal-history-ui.test.ts`, original line 25 | Exact migration list expected through `0071`, actual list additionally contains `0072`; `beforeAll` fails |

The first repair head `8814acc9fa63124d0306aaaa3b657f0c984c0ae7` then passed
quality and PostgreSQL in run
[40038423529](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/40038423529),
but exposed one further fixture gap: `today-readiness-built-page.test.ts` at
original lines 278/281 reported the same unexpected follow-up GET at 390/1280px.
Both cases reproduced locally on that unchanged head in **12.30 seconds**. Its
route handler now uses the same explicit board scope after its existing origin
and exact-write-permit guards. Readiness freshness, movement/override policy,
geometry and unexpected-request assertions are unchanged. This failed run is
old-head evidence, not final-head acceptance.

Local red-before reproduction used the unchanged #450 built app, Node 22, system
Chromium, and disposable PostgreSQL at loopback. `CI=true GITHUB_ACTIONS=true`
enabled the clinical fixture's existing CI-only selection locally; this is a local
synthetic reproduction, not a hosted-run claim. All three failures reproduced:
**3 failed files; 9 failed, 10 passed, 7 skipped cases; 42.93 seconds**. The seven
HR cases were skipped because their `beforeAll` failed.

The adjacent `reception-exact-checkout-ui.test.ts` was separately run unchanged on
the same base: **2/2 cases passed at 1280/390px in 32.43 seconds**, including its
unexpected-request assertion. It is not modified without an observed failure.

## Bounded repair

The actual queue contract is defined by `app/api/appointment-followups/route.ts`,
`parseFollowupPage`, and `readAppointmentFollowupQueue`. The built Today board
requests its unscoped first page with `limit=25`; the clinical fixture navigates
to the patient summary, which requests `limit=25&patientId=98301`. These fixtures do not test the
queue's records, so they return its correctly typed empty envelope:
`{timeZone:'Asia/Aden',items:[],hasMore:false,nextCursor:null}`.

`emptyFollowupsFixtureRead` requires an explicit expected scope: `null` for the
reception board, or `98301` for the clinical patient fixture. It accepts only the
exact same-origin path and GET, with exactly `limit=25` for the board or exactly
`limit=25&patientId=98301` for that patient. A board request in the patient fixture,
a patient request in the board fixture, another patient, cursors, extra/duplicate
keys, other limits, methods, origins and paths remain rejected. No queue request is forwarded to retrieve general patient data.
The helper's return type tracks the actual reader's return type. Production query
parsing is also applied. Unknown-route and unexpected-request assertions remain.

The HR change adds only `0072` to the exact expected list. The withheld-receipts
table test, its `503 integration_pending` assertion and restoration remain intact.
No product, database migration, security policy, workflow or dependency changes.

## Verification

- Fixture boundary and existing guarded-route/patient-fixture units: **47/47**.
- Initial focused rebuilt-app acceptance: **28/28 cases in the first four files passed**, with
  CI-only clinical selection enabled locally, including all seven HR cases and
  the withheld-table 503 check. No cases were skipped.
- Follow-up focused acceptance includes Today readiness: **30/30 cases in five
  files passed**, zero skipped, on the same unchanged product build. Typecheck
  and lint also passed after the additional three-line fixture wiring.
- Build, typecheck and lint passed; the final fixture-only refinement was checked
  again with typecheck and lint. Product build inputs are unchanged.
- Final hosted CI is recorded in the Draft PR with its exact final head; do not
  infer hosted acceptance from these local results.

Focused command (local CI-selection flags as described above):

```sh
npm run test:security-http -- \
  __tests__/security-http/reception-signature-handoff-ui.test.ts \
  __tests__/security-http/clinical-visit-owner-ui.test.ts \
  __tests__/security-http/hr-temporal-history-ui.test.ts \
  __tests__/security-http/reception-exact-checkout-ui.test.ts \
  __tests__/security-http/today-readiness-built-page.test.ts
```

Existing 0071/0072 rollout holds remain. This test repair is not deployment or
activation approval and does not complete the wider appointment mandate.
