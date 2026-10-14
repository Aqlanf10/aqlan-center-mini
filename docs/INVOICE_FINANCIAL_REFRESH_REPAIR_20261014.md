# Invoice-owned parent financial refresh repair

Product checkpoint: **13634e1f758ed9fe588d7fbef9ce67f03f3b4ade**, branch `feat/invoice-resume-20261014`. The coordinator explicitly authorized this bounded defect repair on the invoice branch after reproducing stale parent financial projections. No further merge, design-file change, integration push or deployment is authorized.

## Exact failure and repair

The defect also reproduces on the invoice branch without patient-design changes. A real synthetic invoice of1000 followed by actual UI collection400 updates `PatientLedger` to600 while the parent workflow header retains1000. Receipt reversal, opening changes and acknowledged lost-response recovery similarly refresh only the child ledger. This is stale read authority, not a different financial calculation.

The fresh root-branch before-test on4c17d3a4 finished **0 passed /9 failed /0 skipped**, preserving the actual mismatched header/ledger and8 failure screenshots. `invoice-root-live-before.*` records the exact source, test hash, logs and results. No production patient or Staging database was accessed.

Only `components/PatientLedger.tsx` changes product behavior: **11 added lines /2 changed lines**. It uses the existing `onClinicalChange` callback after accepted opening writes and confirmed collection, durable-money recovery, and receipt-correction acknowledgements. Opening writes notify before awaiting their ledger GET, which may stall. Existing bounded invoice/historical acknowledgement owners keep their own notifications. The helper refuses to notify from an inactive ledger owner.

No balance is guessed, incremented, subtracted or optimistically replaced. The unchanged parent `refreshWorkflow` starts an authorized canonical GET and synchronously clears its summary owner. Its existing failure path keeps the workflow/header unavailable; its existing owner/generation checks prevent stale responses from restoring authority. No design-owned source change is required for those root-page semantics.

| Acknowledgement path | Existing owner / repaired notification |
|---|---|
| Ordinary collection | `CollectPaymentModal` validates the exact durable receipt before `onSuccess`; the ledger now also notifies the parent. |
| Lost collection or receipt-correction reply | `MoneyCommandRecovery` validates replay and consumes the original command; its confirmed `onDone` now also notifies the parent. |
| Receipt correction / reversal | `ReceiptCorrection` retains its full response validation, original receipt target and idempotency; its confirmed `onDone` now notifies the parent. |
| Opening add/edit/delete | The existing `send` success/acceptance branch notifies the parent before awaiting the unbounded child ledger read. |
| Invoice/historical corrections, new agreements and scheduled debt collections | Existing parent notifications remain in place; their guards and writers are unchanged. |

Server permissions, period locks, canonical receipts, immutable facts, transaction logic, FX/native-price rules, visit binding, journal keys and retry bodies are unchanged. This repair creates no new financial records beyond the explicitly submitted canonical operation.

## After-test evidence

`__tests__/security-http/invoice-account-live-refresh.test.ts` runs the real built application and isolated PostgreSQL. It compares the existing patient header and canonical ledger, with no successful financial-response substitution:

- At390/1280/1448, collection400 changes1000→600 in both owners without reload; correction to900 changes both to500; explicitly voiding the ancestor receipt changes both to900. The original payment/refund invoice IDs remain intact.
- Independent receipt reversal refreshes both views without first issuing a correction.
- Opening250 adds to1000→1250; edit to100 gives1100; delete restores1000, with zero receipts.
- A post-acknowledgement workflow503 removes stale authoritative header amounts; the fresh ledger still shows600. An explicit GET retry restores the header without posting another payment.
- An accepted opening acknowledgement invalidates the header while both sibling ledger and parent workflow reads are held. A later workflow503 leaves the header unavailable even after the ledger returns1250. No old authoritative number or fabricated zero appears.
- Collections initiated from Account, Summary and the patient header survive lost committed replies and recover through Account using the exact original key/body. An independent real opening100 added while acknowledgement is pending is reflected in both current balances700 after replay; there is still exactly one receipt.

**After:10/10 passed, zero skipped**, including the same9 prior failures and the additional pending-read case.11 actual after screenshots are retained. Focused ledger feedback, durable money and recovery-label units passed **109/109**, zero skipped. Typecheck and focused lint passed (one existing `previewOwner` warning). Fresh build/environment/full lint/money/raw-body/preflight/runtime gates passed; no timeout was changed.

Current app SHA256: **db5927d164fbc3060ce9f19a5b5b5f7ac7decb9fab6a4fb48a1a7b2cdbbd2efe**. Source plus tests: **6383a3748d879886191c2ed492f833f9cc492303352de68a9881fd82c6d54b7c**. Build **-pvqFxUtGKGjSuuKk50R2**. `invoice-root-live-after.metadata.json` and `invoice-live-build-static.metadata.json` record matching before/after hashes and checkpoint13634e1f. The following documentation delivery does not alter application/test bytes.

```sh
# Same isolated local environment: Node22.23.3, npm11.9, Asia/Aden,
# PostgreSQL18.6 on loopback55439, synthetic HTTP3322/aqlan_sec_http.
npm run test:security-http -- __tests__/security-http/invoice-account-live-refresh.test.ts --reporter=default --reporter=json --outputFile=/workspace/reviews/invoice-resume-20261014/invoice-root-live-after-results.json
npx eslint components/PatientLedger.tsx __tests__/security-http/invoice-account-live-refresh.test.ts
npm run typecheck
npm test -- __tests__/patient-ledger-write-feedback.test.tsx __tests__/durable-money-command.test.ts __tests__/patient-invoice-recovery-labels.test.tsx --reporter=default --reporter=json --outputFile=/workspace/reviews/invoice-resume-20261014/invoice-live-focused-unit-results.json
npm run build
npm run verify:environment
npm run lint
npm run scan:money
npm run ci:scan:body
npm run build:preflight
node scripts/verify-braces-runtime.mjs
```

Evidence root: `/workspace/reviews/invoice-resume-20261014/`; before/after PNG directories `invoice-root-live-before-ui/` and `invoice-root-live-after-ui/`. The preserved earlier combined-head failures remain separate. The new source is the invoice branch itself; no patient-design branch was merged or copied into it.

## Required remaining verification and coordination

Run full units/PostgreSQL, all relevant invoice/currency/recovery/receipt/native-label browser files, operational journeys, schema/ownership/baseline and required exact delivery-head CI. Final commands/results and head-bound receipts are recorded outside Git after the documentation delivery so recording success cannot create a fresh unverified head. The previous961f498b green run and4c17d3a4 currency proof do not substitute for this product head's required CI.

The separately preserved local integration at8d50eb67 remains unmodified, unpushed and **does not contain this repair**. Its premium account overview uses the parent's workflow summary; the callback contract must be preserved by any future authorized design integration. No post-repair combined-head result is claimed. PR330's laterfec2249 WIP and receptiona91fec44 remain excluded.

The historical blank-preview observation is still open. Exact page/button, currency and agreement/paid-before inputs were requested; diagnosis must use that scenario rather than infer a bug from an empty draft or a deliberately collapsed disclosure. Existing current-source historical journeys will be rerun independently. No speculative historical or design change is included here.
