# Integrated signature, reception, and checkout package (draft)

## Pinned source union

Base main: `5d1df1f7e40b0e434099fd174136607bfb56d4c9`. Sources: PR313 `7bac29da31439b19c9040503a144e17b25cca71a`, PR316 `9bfa4f98836d85cbf8a7988756fa4706cd9e4381`, PR317 `5d347024cdc13415215fb3526d59339eb4b8946a`, PR318 `5b3722120ed8331956814fece837b3de9a030895`. The source diffs contain 19 + 13 + 9 + 11 = 52 distinct paths, with no overlap against this base. The integration preserves source ancestry and adds the coordinated exact-checkout seam, bounded layout correction, and test-contract reconciliation. No CI/deployment configuration, migration, credential, or accounting writer change is introduced by the integration.

## Implemented read contract

- The existing Today board has a front-desk signing register. It polls every 20 seconds, retries on focus/online/visibility, and has an explicit retry action. Request timeout is 12 seconds.
- `GET /api/visits?view=reception-handoff` requires a current session and role `admin` or `reception`, matching the front-desk branch of existing walkout permission. Cashier cannot open the clinical checkout. Doctors, including doctors with payment access to their own patients, do not receive this clinic-wide register.
- The ordinary `/api/visits` and public display projections are unchanged. The new response contains only visit/patient identity and committed signature timestamp, no clinical work, money, notes, or payment status.
- It derives directly from `visits.signed_at` and the existing patient record. Chair completion and arrival day do not determine membership. No message insertion, financial write, migration, second queue, or acknowledgment persistence is introduced.
- The default window is the current and previous clinic day. `date=YYYY-MM-DD` selects the two signing days ending on that date, including older periods. The UI displays the precise window and says explicitly that older collection reviews may remain. This is a signing register, not an unpaid/deferred/settled list. Collection and zero-invoice state never remove a row.
- Dates use the existing server `CLINIC_TIME_ZONE` and clinic-day SQL helper. The window has no silent row-count truncation.
- Responses carry principal identity and are strictly parsed. Permission loss or changed response principal clears the register. Ordinary failure preserves a labeled stale snapshot with checkout links disabled. An empty success is shown only for a complete validated response.
- Component ownership is keyed by principal/permission state and date window. Retired responses cannot update a newer owner, including A→B→A. Polls do not overlap; repeated responses do not duplicate entries or repeat the sound. Reload restores existing signatures without playing an initial discovery chime. There is no durable acknowledgment or promise of cross-device acknowledgment.

## Exact checkout integration

The integrated patient workspace consumes `/patients/{patientId}?tab=today&checkoutVisit={visitId}` through Next page searchParams. The following contract is implemented in this package; runtime acceptance remains pending:

1. Exactly one positive safe-integer `checkoutVisit` is accepted. Missing selection retains the ordinary workflow; malformed/repeated parameters show an explicit error without selecting another visit.
2. `requestedCheckoutVisitId` reads only that authorized walkout. PR316 validation requires matching patient and visit, signed state, and complete independently validated native-currency maps before enabling collection.
3. Explicit historical selection bypasses `lastVisit`, `signedToday`, and newer-open suppression only for that selected visit. Its identity stays visible; a newer open visit is named separately and its clinical editor is not mounted in the selected checkout. Normal clinical-draft ownership remains keyed by patient, unaffected by transient financial authority refreshes.
4. Missing/unsigned/wrong-patient/forbidden/malformed reads remain unavailable without fallback. Header action stays within selected checkout. Explicit refresh and collection callbacks reload canonical live balances. PR313 durable attempt identity/recheck and existing collection/correction writers are retained.
5. Built-page tests cover exact navigation, held A→B→A reads, malformed URL, patient/signature refusal, newer-open coexistence, independent currencies, failed refresh after collection, and a held allowed response superseded by permission refusal. Unit tests protect ordinary clinical-draft keys and exact-checkout retirement.

Current debt is the live canonical ledger. Previous balance retains the existing engine definition, excluding this visit invoice and all payments on its arrival day; it is not a frozen pre-sign snapshot. Three TD05 browser tests now assert this contract with stable per-currency markers and positive `data-financial-state=verified`, retaining their persisted payment/identity assertions. The walkout retry regression uses PR313's existing recheck action after an uncertain HTTP500 and verifies the same payload/idempotency key while ordinary submit/input remain locked.

## Verification boundary

New unit, route, PostgreSQL, and built-page browser tests are prepared for the existing disposable GitHub CI. The browser journey uses two independent authenticated contexts, signs through the real HTTP route, and expects the already-open reception board to discover an older-arrival `done` visit via its normal timer. PostgreSQL cases cover canonical no-invoice sign, adjustment-only sign, retained opening, concurrent sign/retry, rollback visibility, and clinic-midnight/date retrieval. Synthetic transport cases cover stale/malformed/denied/changed-principal data, late date responses, reload, and mobile/desktop geometry.

No local dependencies, build, tests, app, or SQL were run. Initial PR318 CI1730 attempts1/2 failed pulling `postgres:18-alpine` from Docker Hub before checkout; no application check ran. Runtime pass claims require the final integrated commit's full existing CI, independent source review, and authorized synthetic Staging acceptance. No Production write, deployment, or real patient correction is claimed.
