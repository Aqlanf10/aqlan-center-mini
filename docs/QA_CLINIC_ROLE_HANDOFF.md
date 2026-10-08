# Practical cross-role clinic audit

## Current state

One real cash-desk defect is reproduced; the whole-clinic audit is not complete. This document extends canonical `SAFE-13-CASH-PATIENT-SEARCH` and the existing patient-finance / one-patient-one-ledger acceptance work. It does not reopen the released quick-booking SAFE-13 fix or create a new financial engine.

Audited product: main `bdcaf5bb4829e429fada5f77e23844e0bfb87fa9`.
Counterfactual test-only head: `a63fa6a13eb5a225407a1932476cc76945614f2c`.
Its exact tree `c9f94b07bb59c3238544aeba9276eb946af1cb9d` preserves all 1,768 original leaf entries and adds only the browser audit test. The test's original SHA-256 is `f7fe404ec88c8ba03ccf17fd21dd4930327a0cb585b6e3885d98743f3043fbeb`.

## P1: stale cash-desk patient under a newer query

Safe reproduction in the existing isolated CI harness:

1. Sign in as the actual synthetic cashier and open the quick-collection patient picker.
2. Enter synthetic patient ALPHA's query; hold its genuine successful server response.
3. Enter synthetic patient BETA's query; let that genuine result appear.
4. Release ALPHA's older response. Do not select a patient or submit money.

Expected: the visible BETA query still offers BETA, and an older response cannot change the patient eligible for selection.

Observed in two independent executions: `inputIsLatest=true`, `oldPatientButtons=1`, `latestPatientButtons=0`, `oldStatus=200`; payments remained zero before/after. Actual 390×900 pixels show BETA in the search field above the ALPHA patient button. This is a financial patient-selection risk, not evidence that a real receipt was posted to the wrong patient.

| Source | Verified execution | Observed PNG |
| --- | --- | --- |
| [Push run37710425225](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37710425225), [job113094824585](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37710425225/job/113094824585) | checkout a63fa6a, attempt1, terminal failure | `cashier-search-race-observed-390`, 77,734 bytes, SHA-256 `c26403a6c7dee312c3957e8d6a2a7eb196c85e2ae9ce80f35be12baa0d602d0f` |
| [PR run37710434191](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37710434191), [job113094853856](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/37710434191/job/113094853856) | checkout 231898ca6db32756d61d2c9ffc990505dd300931, independently verified identical c9f94b07 tree, attempt1, terminal failure | same scene, 77,573 bytes, SHA-256 `bc0cb7b387d827b50a60a04ab24bd7b81311d46d6005b8c13310d079098d55cb` |

Images were reconstructed only after verifying the exact run/attempt/checkout/source hash, final manifest, complete unique indexed chunks, byte counts, SHA-256 and PNG dimensions/CRC. They are complete diagnostic scenes of failed runs, not passing acceptance packets.

Both runs passed 7,172 unit / 1,403 PostgreSQL / 1,044 existing HTTP-browser cases, with two newly added tests failing. The second failure is the product witness above. The first is a test-observation problem: after patient creation returned 201, the application's real `window.location` navigation retired Chromium's response body before `response.json()` read it. The successor inspects the committed unique synthetic patient row after confirmed 201 and verifies the navigated patient URL. It keeps genuine UI registration, all financial assertions and the original red search witness. No fake creation response or direct patient-insert shortcut replaces that story.

## Bounded repair under review

`QuickCollectModal` choices and callbacks belong to the exact query/request, modal lifetime and current username/role/permission identity. Input changes synchronously withdraw old choices and retire even retained default-debtor callbacks before React commits; close, unmount and principal transitions retire outstanding work. Both after-headers and post-JSON checks protect result publication, while guarded catch/finally cannot erase newer results or loading state. Logical retirement remains effective even if transport completion cannot be cancelled. The 200ms debounce and existing backend financial/role rules remain.

The original real-response browser witness is unchanged. Added 1280px/390px browser cases use actual synthetic patient reads for immediate query withdrawal, close/reopen with the same query, late old response while the new lookup is pending, explicit current selection and clearing. They do not submit money. Deterministic component tests additionally cover post-JSON completion, short/cleared queries, retained callbacks before commit, same-text retry, username/role/permission/null ABA, errors and single selection. Those unit lifecycle tests are explicitly not browser/backend evidence.

The modal closes and remains retired on a principal/role/permission transition until the parent observes closed and an explicit new open occurs. Existing `canHandleMoney`/`financeAccessFor` policy prevents denied roles from opening collection; a cashier without `viewPatientLedger` sees no inherited debtor figures or default debtor suggestions, including monetary suggestions attached to search results. Identity search stays available when collection is allowed.

Boundary: parent `FinancePage` separately masks the picker while a changed username/role lacks a fresh shift read and closes it when the shift/principal context changes. Its `debtRows` projection itself is not principal-tagged and refreshes separately after successful debts JSON. This bounded modal fix does not certify the parent's broader financial-read freshness or make inherited debtor totals current. That remaining source observation belongs under existing PATIENT-FINANCE acceptance; there is no new ledger/financial-read rewrite here. Tests with nonempty parent debtor props prove closure, explicit re-entry and current ledger-visibility suppression, not freshness of every parent financial figure.

Current state is **repair prepared; exact successor CI and independent review pending**. No passing fixed-head, merge, Railway release or Production-data change is claimed here.

## First cross-role acceptance spine and remaining scope

The first browser story uses genuine reception, manager, doctor, cashier and accountant cookies with one synthetic adult patient: UI registration → linked waiting visit → authorized manager doctor assignment → clinician notes/consultation/review cancellation/signing → cashier partial YER collection/receipt → accountant read and write denial → same-shift manager reconciliation. Intended figures are 12,000 YER billed, 4,000 on-account collected, 8,000 due; SAR/USD remain separate zero buckets. Manager opens blind-count fields and cancels, preserving other tests' shared synthetic shift.

This entire handoff remains pending until its repaired observation runs. It does not certify physical seating, scheduling capacity, plans/cases/consent, specialty sessions, refunds, expenses/payees, actual end-day close or every report. Those remain the existing roadmap owners. Invoice-first/legacy work remains in its separately owned unreleased stack; print toolbar and daily close remain separate bounded work. No invoice implementation, ledger writer, schema, CI/workflow, permissions, backup or real Production record changes belong to this search repair.

The existing `vitest.config.security.mts` serializes files and cases (`fileParallelism:false`, `maxConcurrency:1`, one fork); the same-shift delta does not assume a globally empty balance. Loopback app/database and exact disposable database identity are checked before fixture writes. The real clinic clock remains: a midnight transition must be distinguished from a product failure. Future AI/Dot features are excluded.
