# Portal: previous-treatment details («العلاج السابق»), finance slice 1a

Draft for independent review, per #451 comment 6386137298 (slice 1). **Not for merge or deployment.**
- Built on the frozen candidate `c998b435`; nothing is written to its branch.
- Synthetic data only, on local disposable databases.

## The gap

#447 made the **current printed statement** show historical treatment agreements: the saved lines, discount, agreed amount, paid before and remaining. The history read was deliberately opt-in for the print only, so the patient portal issued no historical query. As a result, a patient whose balance comes from treatment before the system saw it explained on paper but **not in the portal**.

## Change

| File | Change |
|---|---|
| `lib/db.ts` | `patientStatementSnapshot(..., { historicalAgreements: "tolerant" })`. It runs the same reader on the same snapshot client. Only the reader's own typed validation error (`StatementHistoricalDetailsError`, thrown after both queries have completed) becomes `null`. Database errors still fail, so an aborted transaction is never reused. `true` (the print) still fails closed. |
| `lib/portal-statement.ts` | `historical`: either `{ available: true, agreements, undetailed }` or `{ available: false }`. It is built from the print's own `historicalOpeningBuckets`, reduced to an allowlist: date, currency, line description, site, quantity, unit price, discount and net; gross, discount, agreed, paid before and remaining. No document, revision or standalone ids, and no kind or version. Unrecorded values stay `null` and are never invented as zero. |
| `app/api/portal/statement/route.ts` | Reads `"tolerant"` in the same snapshot as the ledger and plans, and builds the buckets from that snapshot's openings and receipts. |
| `app/portal/page.tsx` | The «العلاج السابق» section uses the print's labels and «غير مسجل» for unrecorded values. As on the print, it appears only when genuine historical treatment exists. When `available: false` it shows an Arabic notice that the details are temporarily unavailable and that the displayed balances do not depend on them. |

**What does not change:**
- Every number and the canonical ledger: balances come from `ledgerBalancesByCurrency` exactly as before.
- No receipt, invoice, credit or cash movement is created.
- YER, SAR and USD stay separate.
- The print's behaviour is unchanged.

## Default chosen, pending the owner (map 6386169726, row 1a)

A malformed saved historical fact withholds only the portal section, with a notice. The statement figures, which never depend on it, still load. The print keeps failing closed. If the owner prefers the portal to fail entirely like the print, only the `"tolerant"` option changes.

## Evidence

| Suite | Red before (base `c998b435`) | Green after |
|---|---|---|
| `__tests__/portal-statement-historical.test.ts`: allowlist, order, standalone `null`, undetailed opening, unavailable | 3/3 fail (no projection) | 3/3 |
| `__tests__/portal-statement-parity.test.tsx`: exact feed keys, no internal strings | the keys test fails | 9/9 |
| `__tests__/postgres/statement-historical-details.test.ts`: the portal in YER and in SAR ×100 matches the print's reader and buckets on an independent snapshot; exactly 2 historical queries; allowlisted keys; canonical balances and due unchanged; a malformed fact gives `{available:false}` with every other field byte-identical, while the print rejects | 3 fail (0 historical queries; no `historical` field) | 16/16 |
| `__tests__/security-http/portal-statement-historical-ui.test.ts` (built app, real endpoints, its own synthetic portal patients, 390 px and 1280 px): DOM line cells and totals equal the feed, in YER and SAR ×100; no ids in the section; no other patient's history; currency separation; due unchanged | 4/4 fail (the section never renders) | 4/4 |
| Existing `portal-statement-detail-ui` and `patient-statement-historical-print-ui` | — | pass |

The full unit suite, lint and the hosted CI for the final head are reported in the PR.

## Not in this slice

- **1b:** historical details in the dated statement (`?to=`). It needs a cutoff contract for the revision in force at that date.
- **1c:** opening-balance correction against an active repayment schedule. Awaiting the owner's decision.
- The portal still shows its existing «رصيد سابق على النظام» opening cards. The print suppresses the duplicate top opening line for currencies explained by history; aligning the portal with that is a separate presentation decision.
