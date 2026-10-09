# Reception signature handoff (draft)

## Implemented read contract

- The existing Today board has a front-desk signing register. It polls every 20 seconds, retries on focus/online/visibility, and has an explicit retry action. Request timeout is 12 seconds.
- `GET /api/visits?view=reception-handoff` requires a current session and role `admin` or `reception`, matching the front-desk branch of existing walkout permission. Cashier cannot open the clinical checkout. Doctors, including doctors with payment access to their own patients, do not receive this clinic-wide register.
- The ordinary `/api/visits` and public display projections are unchanged. The new response contains only visit/patient identity and committed signature timestamp, no clinical work, money, notes, or payment status.
- It derives directly from `visits.signed_at` and the existing patient record. Chair completion and arrival day do not determine membership. No message insertion, financial write, migration, second queue, or acknowledgment persistence is introduced.
- The default window is the current and previous clinic day. `date=YYYY-MM-DD` selects the two signing days ending on that date, including older periods. The UI displays the precise window and says explicitly that older collection reviews may remain. This is a signing register, not an unpaid/deferred/settled list. Collection and zero-invoice state never remove a row.
- Dates use the existing server `CLINIC_TIME_ZONE` and clinic-day SQL helper. The window has no silent row-count truncation.
- Responses carry principal identity and are strictly parsed. Permission loss or changed response principal clears the register. Ordinary failure preserves a labeled stale snapshot with checkout links disabled. An empty success is shown only for a complete validated response.
- Component ownership is keyed by principal/permission state and date window. Retired responses cannot update a newer owner, including A→B→A. Polls do not overlap; repeated responses do not duplicate entries or repeat the sound. Reload restores existing signatures without playing an initial discovery chime. There is no durable acknowledgment or promise of cross-device acknowledgment.

## Integration dependency: do not merge yet

The link carries `/patients/{patientId}?tab=today&checkoutVisit={visitId}`. Baseline `5d1df1f` does not consume that exact-visit parameter. This draft is **not an end-to-end finished checkout handoff** and must not merge until the following seam is integrated after PR316/PR317 land:

1. The patient workspace parses exactly one positive safe-integer `checkoutVisit`, with an explicit unavailable state for invalid or repeated parameters. Do not silently fall back to another visit.
2. Pass `requestedCheckoutVisitId?: number | null` to `TodayVisitTab`. An explicit request reads only that visit's existing authorized walkout. It must validate both patient and visit id and signed state before enabling any collection.
3. Explicit historical selection bypasses `lastVisit`, `signedToday`, and newer-open suppression. Show the selected visit identity; coexistence with a newer open/signed visit must never redirect collection or overwrite its balances.
4. Missing/unsigned/wrong-patient/forbidden/malformed/error responses remain unavailable. Preserve PR316 strict balances, independent native currencies, and no-new-charge semantics; retain existing collection writers.
5. Real built-page tests must click through to the exact checkout and prove A→B→A ownership, malformed query, another-patient refusal, newer-open coexistence, live payment refresh, and permission invalidation before release.

## Verification boundary

New unit, route, PostgreSQL, and built-page browser tests are prepared for the existing disposable GitHub CI. The browser journey uses two independent authenticated contexts, signs through the real HTTP route, and expects the already-open reception board to discover an older-arrival `done` visit via its normal timer. PostgreSQL cases cover canonical no-invoice sign, adjustment-only sign, retained opening, concurrent sign/retry, rollback visibility, and clinic-midnight/date retrieval. Synthetic transport cases cover stale/malformed/denied/changed-principal data, late date responses, reload, and mobile/desktop geometry.

No local dependencies, build, tests, app, or SQL were run for this draft. No Staging or Production writes or deployment are part of this slice. Runtime pass claims require the exact published commit's existing CI result. Exact destination integration and its end-to-end verification remain pending independently of queue test outcomes.
