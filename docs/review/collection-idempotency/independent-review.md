# Independent read-only review

Reviewer: delegated agent `/root/independent_review`, not the implementer.
Scope: main `9e8fd301ebcdee1197b75bc6d182861ff35712b8` to candidate `b7652c35`, including the two subsequent authorized fixture header edits. Review performed in the same workspace, without edits, Chromium, production data, downloads, or external writes.

**Verdict: no blocking correctness finding in the scoped change. Suitable for parent review, with the coverage limits below.**

## Reviewer evidence

- `app/api/payments/route.ts:145` rejects missing/blank keys before settings lookup and all ordinary receipt/installment writers. `app/api/plans/[id]/route.ts:43` rejects before fetching the plan or writing. Explicit recovery validates its key in `lib/reversed-installment-recovery.ts:188`; debt collection validates before schema initialization/transaction in `lib/debt-installment-collection.ts:14`.
- `components/CollectPaymentModal.tsx:115,164` and `components/PatientPlans.tsx:179,215` use the durable hook. Traced wrappers through ArrivalPanel, TodayVisitTab, SummaryTab, PatientLedger, `app/patients/[id]/page.tsx:1433`, `app/finance/page.tsx:794`, and reception/appointments arrival entrypoints.
- Registration at `app/patients/page.tsx:286` posts patient identity and previous-balance fields to `/api/patients`; it is not a separate receipt collector.
- Foreign-currency collection uses the same durable path; target/currency rules remain unchanged (`CollectPaymentModal.tsx:103–164`, payment route 126–136).
- `components/useDurableMoneyAttempt.ts:49–65` retains the synchronous sending lock, prohibits changing unresolved request bodies, preserves the existing key, awaits journal reservation before POST, and posts saved body/key. Uncertain outcomes retain the command at lines 74–84. IndexedDB CAS implementation at `lib/financial-command-journal.ts:97,121–133` is unchanged.
- Both additional fixture edits add only explicit `Idempotency-Key` headers. Their bodies, assertions, and execution paths are unchanged.
- Remaining direct unkeyed `authedMutation("/api/payments", …)` tests are intentional authorization/invalid-recovery/missing-key cases. Internal scripts call writers directly and remain outside this HTTP-only change.

## Independently executed by reviewer

```sh
npm test -- __tests__/collection-idempotency-boundary.test.ts __tests__/use-durable-money-attempt-headless.test.ts __tests__/durable-money-command.test.ts __tests__/reversed-installment-recovery-routes.test.ts
git diff --check
```

**4 files, 83 tests passed, exit 0. Diff check passed.** These are reviewer-run results, separate from the implementer's HTTP/PostgreSQL/build/typecheck results in README.md.

## Limits

The reviewer did not independently run HTTP/PostgreSQL, build, or Chromium. Headless hook tests mock React lifecycle and journal storage, so they do not establish actual browser reload/IndexedDB/multi-tab behavior. HTTP regression tests establish server replay identity; actual lost-response behavior is covered only by the controlled hook test here. No production data or reported-patient cause was investigated. Review requested updating the earlier deferred-fixture documentation; README.md now records the completed header-only delta and removes that blocker.

## Correction to initial completeness assessment

Hosted run `39640370875` subsequently exposed two successful collection fixtures in `__tests__/td05-owner-review.test.ts` using a dynamic route import without keys. Both the implementer audit and this initial independent audit missed them. The initial no-blocker/completeness assessment was therefore insufficient for the full suite. README.md preserves the failure and the authorized header-only correction; no earlier test result is represented as a full-suite pass.

The reviewer repeated the source audit over static/dynamic handler imports, `new Request`, `jsonRequest`, `post`, `send`, `authedJson` and HTTP helpers. No additional successful collection fixture lacking a key was found. Remaining unkeyed owner-review calls at 287/302/365 and owner-review-2:269 exercise invalid foreign/dual targets; `payment-acknowledgment-evidence.test.ts:368` intentionally omits a correction key. The two fixed headers leave bodies/assertions unchanged.

Reviewer independently ran:

```sh
npm test -- __tests__/td05-owner-review.test.ts __tests__/td05-owner-review-2.test.ts __tests__/inactive-plan-collections.test.ts __tests__/reversed-installment-recovery-routes.test.ts __tests__/collection-idempotency-boundary.test.ts
```

Result: **92/92 across five files passed**, exit 0; `git diff --check` passed. No further blocker found for this fixture-only correction. This remains a targeted review, not proof of a complete hosted/browser suite pass.
