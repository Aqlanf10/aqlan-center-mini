# Verification and handoff

Branch: `fix/invoice-currency-settlement-recovery`, based on main
`4f65b60793db94c1ca8c8a52a32acd83d666c5fb`. Draft PR: [#343](https://github.com/Aqlanf10/aqlan-center-mini/pull/343).

## Delivered scope

- Money recovery reports blocked/busy/null and later refusal outcomes without
  deleting or rotating the pending financial command. The UI explicitly explains
  why correction is blocked and that retry POSTs the original intent.
- Existing invoice debt schedules accept subsequent ordinary receipts with fresh
  keys. Stable debt-source facts and immutable settlement extension are checked
  separately; original full source hashes remain for optimistic previews.
- PostgreSQL regression was red before repair (only one of three 200 SAR payments
  succeeded on a 600 SAR invoice) and passes after repair. Guards for refunds,
  receipt correction, principal/cancellation, overcollection and actor revocation
  remain tested. No snapshot rewrite or migration is used for this repair.
- Currency reclassification is **design/prototype only**, not wired to routes,
  writers or readers. Do not present this PR as enabling paid invoice currency
  correction. See [design and unresolved integration](design.md).

## Results on final product source

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass (repeated after final test edit) |
| `npm run lint` | Pass; 0 errors, 208 existing warnings |
| `npm run build` | Pass, production build |
| `npm run scan:money` | Pass |
| Full `npm test` | 563 files passed; 10046 passed, 1 skipped |
| Full PostgreSQL 18 suite | 217 files passed; 2295 tests passed |
| Focused PostgreSQL debt regression/guards | 2 files, 14 passed |
| Built HTTP/Arabic UI | 16 selected files, 112 distinct tests passing across original run and focused rerun |

HTTP accounting: 15 files / 101 tests passed in the broad final run; the repayment
workspace file had 9 pass and 2 test-locator failures **after** all three collections
and `requiresReview=false` assertions succeeded. The old test then tried to edit
the second unpaid row, but the first scheduled amount was already fully settled,
so only one unpaid row correctly remained. The test was corrected to edit that
remaining row. Its complete rerun passed 11/11; product code did not change.
Both the first run and rerun logs are retained below. This is not a claim that the
entire repository HTTP suite ran.

## Reproducibility

All SQL ran against new local disposable PostgreSQL 18 containers and synthetic
patients. No live database, receipt, invoice, permission or staging service was
changed. Set an isolated `TEST_DATABASE_URL` targeting `aqlan_p1_test`, a synthetic
`SESSION_SECRET` of at least 32 characters, and `CLINIC_TIME_ZONE=Asia/Aden`.
For the full PostgreSQL suite also set `CATEGORY_HISTORY_CI_DISPOSABLE_FIXTURE=1`
and `MANUAL_CASH_CI_DISPOSABLE_FIXTURE=1` on that disposable database only.
Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium` in this workspace.

Commands: `npm test`, `npm run test:postgres`, `npm run typecheck`, `npm run lint`,
`npm run build`, `npm run scan:money`. The built HTTP selection was:

```sh
npm run test:security-http -- money-durable-recovery money-attempt-real-react \
  invoice-correction invoice-identity-correction invoice-revision-recovery \
  commission historical-correction-recovery reversed-installment-recovery \
  patient-invoice-recovery-labels debt-repayment-workspace
npm run test:security-http -- debt-repayment-workspace
```

The first local PostgreSQL attempt used a wrong disposable database name and was
rejected by the target guard. A subsequent run omitted the synthetic session
secret and was interrupted after setup failures; it is not counted as passing.
Correctly configured full suites were then run. Playwright's browser download was
blocked (403); the existing local Chromium ran the actual browser tests.

## Evidence

- [Sequential-debt red regression](evidence/debt-sequential-before.log)
- [Sequential-debt and safety guards after repair](evidence/debt-sequential-after.log)
- [Full PostgreSQL output](evidence/postgres-final.log)
- [Full unit output](evidence/unit-final.log)
- [Broad HTTP run, including the two test-locator failures](evidence/financial-http-first-pass.log)
- [Complete repayment workspace rerun](evidence/debt-http-final.log)
- Recovery refusal: [390px](evidence/refusal-390.png), [1280px](evidence/refusal-1280.png)
- Correction unlocked after exact acknowledgment: [390px](evidence/correction-unlocked-390.png), [1280px](evidence/correction-unlocked-1280.png)
- Three receipts / one invoice / remaining debt after schedule cancellation:
  [390px](evidence/debt-repayment-reception-390.png), [1280px](evidence/debt-repayment-admin-1280.png)

## Remaining owner decisions / blocked scope

Migration 0063 is proposed, not allocated or registered; 0062 HR remains untouched.
Currency integration needs explicit coordination on `lib/db.ts` and
`lib/migrations.ts`, both in PR342's excluded file set. None of PR342's files was
changed. Paid/locked commissions and shared-plan ownership require the fail-closed
policy documented in the design before enabling currency changes. Full approved
agreement debt recognition is a separate migration contract; draft plans and
historical installment invoices must not be double-billed. `lib/reports.ts` cutoff
work and `computeDebtRows` snapshot work are outside this branch's ownership.

CI, review, merge and deployment remain the parent's responsibility. No merge or
deployment was performed; green local tests do not complete the currency feature.
