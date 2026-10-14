# Reception design and journey checkpoint

Starting reception head: `d9690edf747d34da2195badb9c7b7863e7270abd`, tree `99114c58323560240e73e5d738d4138f8175de41`, on `feat/reception-checkout-followon` / draft PR327. The invoice base remains `03d325a8b6511098237458c38444620db59709e7`; no other branch has been merged.

## Reference and ownership

The original Library HTML could be resolved but could not be downloaded: environment DNS failed, and Library text reads returned `Transport closed`. The parent supplied a repository reference at `4538f57bb0171ee8d4b9428316633b331e024c0b` on `codex/patient-reference-fidelity-20261014`. The following were downloaded and inspected:

- `docs/ux/PATIENT_PREMIUM_PHASE1_REVIEW.md`
- `docs/ux/evidence/phase1/summary-reference.png`
- `docs/ux/evidence/phase1/account-reference.png`
- `app/patients/[id]/patient-premium.module.css` (read-only comparison)

The reference has white panels with fine blue borders, compact headings, a blue selected tab with an orange underline, restrained orange emphasis, and Arabic Plex typography. Reception uses the owner's specified palette: `#057bdc`, `#079bf5`, `#0a4788`, `#143f68`, `#ff8b2b`, `#f3f9ff`, `#dcebf7`, with darker action shades where needed for readable text. It inherits the existing local Plex font. This is a reception adaptation, not a claim that the whole reference or the patient agent's implementation is complete.

Production ownership is confined to `app/page.tsx`, the three existing reception/checkout components, and new `components/today/reception.module.css`. No global sidebar, global stylesheet, patient component, invoice writer, payment writer, ledger, API, database helper, schema, dependency or CI file is changed in this successor.

## Journey and integration contract

- Existing arrival, chair/readiness, operational finish and clinical signing keep their separate authority and server contracts. A failed arrival retains the entered patient fields so the receptionist can recover.
- Finishing a session opens the collection tab for that exact visit and requests a fresh queue. Returning from the patient's account restores the collection context. A busy queue read schedules the requested follow-up read instead of discarding it.
- The current invoice API creates account/plan/procedure financial records. It does **not** take an exact visit-link contract in this base. Reception must not guess the latest account invoice. The manager-invoice/arrival/finish/partial-payment test uses the real unlinked contract without SQL association.
- **Invoice branch dependency:** a future explicit visit–invoice association must validate exact patient and visit ownership, refuse link drift and competing links under locks, preserve invoice idempotency and return the committed association. The reception branch does not implement a second linking or invoice engine.
- Signed checkout continues to use the existing exact `checkoutVisit` route. Unsigned checkout opens the canonical account so the operator chooses an explicit invoice/payment target. YER/SAR/USD remain separate.
- Operational handling and deferral require a trimmed 3–300 character reason and the existing fresh proof. They preserve the account debt and historical audit. A saved decision closes its details, including when the operator reviews a previously handled item from history.
- The POST decision acknowledgement is checked against the exact patient, visit and finish revision before the UI reports success. A synchronous guard suppresses repeated client submissions. Server replay/locking rules remain unchanged.
- Pending, handled/deferred history, financial re-review, 20-second polling, notification revision identity and stale/session guards are retained. The collapsed list keeps its existing 256px scroll limit and keyboard focus; opening details allows natural page scrolling.

## Verification checkpoint

The new real-browser regression failed on the starting build: a completed financial re-review remained expanded in history (`history-close-red.log`). It now passes and verifies preserved audit, unchanged receipts and a remaining balance of 600 after a 400 partial payment on a 1,000 invoice.

The first changed-browser run exposed five failures in the existing tab counter assertions; correcting the visible counter then exposed two existing collapsed-list size assertions. The counter format, accessible tab names and conditional list bound were restored. Those existing tests were not edited. Failure logs are preserved with the external review artifacts. Inspection of the actual mobile screenshot also exposed an overly narrow arrival name input; its layout is now a full-width name field above phone and submit.

Final local validation:

| Check | Result |
| --- | --- |
| Production build and Typecheck | Passed |
| Full ESLint | 0 errors, 189 existing warnings |
| Focused unit | 191 passed in 16 files |
| Real PostgreSQL 18.6 | 55 passed in 6 files |
| Built-app HTTP/browser | 32 passed in 5 files |

Browser coverage includes real authenticated manager/reception/doctor/cashier/accountant flows, invoice and receipt replay, exact V1 while V2 is current, A→B→A/back/forward, retired reads, revoked authority, stale proof and required reasons, signature notifications without historical replay, invoice link-loss/refund review, bounded pending/history, keyboard tabs and completed-panel dismissal. The new manager invoice-first journey uses the actual unlinked API contract and proves the 600 remaining debt after partial collection and reasoned deferral at both widths. A narrowly injected 503 arrival response proves fields are retained and no visit is created on failure. PostgreSQL concurrency tests use actual lock barriers, including owner/link drift and concurrent decisions. No production or ledger writer changed.

Full duplicate local suites were not run. Full CI belongs to the exact pushed draft head and is reported separately in the PR/handoff; these local results do not claim CI completion. No live/staging or physical-device test was run.

## Native visual evidence

All screenshots are from the built application with synthetic data and real local PostgreSQL. Each is a single native 900px-high viewport, captured without stitching, zoom or replacement CSS. The arrival screenshot is taken before the injected failed-request case; the other pictures use actual API data. Signed/unsigned linked fixtures explicitly establish their synthetic association; invoice-first flow pictures use the real unlinked contract. Existing global navigation is intentionally unchanged and differs from the separate patient reference branch.

| Scene | 1280 × 900 | 390 × 900 |
| --- | --- | --- |
| Today | [Desktop](evidence/reception/reception-day-1280.png) | [Mobile](evidence/reception/reception-day-390.png) |
| Arrival fields | [Desktop](evidence/reception/reception-arrival-1280.png) | [Mobile](evidence/reception/reception-arrival-390.png) |
| Waiting | [Desktop](evidence/reception/reception-waiting-1280.png) | [Mobile](evidence/reception/reception-waiting-390.png) |
| Chair / finish | [Desktop](evidence/reception/reception-chairs-1280.png) | [Mobile](evidence/reception/reception-chairs-390.png) |
| Paid unsigned / operational decision | [Desktop](evidence/reception/unsigned-paid-1280.png) | [Mobile](evidence/reception/unsigned-paid-390.png) |
| Deferred history after partial collection | [Desktop](evidence/reception/reception-history-1280.png) | [Mobile](evidence/reception/reception-history-390.png) |

The paid-unsigned screenshots and accompanying geometry JSON show patient, exact visit, missing clinical documentation, invoice/receipt amounts, reason and both bottom decision controls within the same viewport. Hit checks and horizontal overflow checks pass. Arrival, waiting, chair and history images were also visually inspected. `evidence/reception/manifest.json` binds the source and image bytes.

All work uses the saved cloud workspace and disposable synthetic PostgreSQL 18.6. No live/staging data, merge or deployment. Parent review and coordination of the explicit invoice-link contract remain required before integration; no unrelated invoice is selected as a fallback.
