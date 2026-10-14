# Correction-lineage invoice settlement adapter

Invoice-owned entry point: `readInvoiceSettlementPosition(client, { patientId, invoiceId, currency }, lock = false)` in `lib/invoice-settlement-position.ts`. Reception integration consumes this contract after the invoice checkpoint; this change does not edit reception screens or replace its paused signature fix.

The caller supplies an explicit invoice and its authorized patient/native currency. The reader never guesses the latest visit/invoice and never draws on unrelated patient credit. A plain read uses the caller's repeatable-read transaction. An authoritative write/proof check revalidates the current session and obtains patient → linked visit(s) → invoice locks first, then calls with `lock=true`; never acquire invoice before visit. Repayment terms and collection follow this order.

The adapter validates the entire explicit correction lineage: one linear same-patient/currency chain, cancelled ancestors, valid invoice amounts, and valid same-owner receipt/refund references. Missing, foreign, malformed, cyclic/branched or live-ancestor history fails closed with `InvoiceSettlementError` (`missing` / `invalid`). Do not turn that refusal into a zero balance or accept an earlier proof.

Returned fields:

- `principalMinor`: current invoice total minus discount, only when current invoice is available.
- `settledMinor`: actual net settlement from the current invoice and all explicit ancestors, applying canonical currency settlement rules.
- `remainingMinor = max(0, principalMinor - settledMinor)` and `creditMinor = max(0, settledMinor - principalMinor)`.
- `lineageInvoiceIds`, `paymentIds`: explicit provenance. `available` is false for a cancelled target; checkout should request the actual current invoice.
- `proofHash`: SHA256 of the owned invoice/correction/receipt snapshot, including individual receipt identity, kind, amounts, currency, exchange rate, reversal link and timestamp. Store this as a freshness token, never financial authority. Re-read and compare immediately before acting; a refund or unchanged-net receipt change invalidates it.
- `sourceSnapshot`: server-side provenance for existing financial command fingerprints. Do not expose this entire financial snapshot through reception's public/display projections.

Examples, in one native currency:

| Current correction chain | Actual net settlement | Remaining | Credit |
|---|---:|---:|---:|
| Original 1000 → replacement 900; original receipt 400 | 400 | 500 | 0 |
| Original 1000 → replacement 900; original receipt 1000 | 1000 | 0 | 100 |
| Original 1000 → 950 → 900; original receipt 400, ancestor refund 100 | 300 | 600 | 0 |

Existing `payment.invoice_id` values remain unchanged. No correction creates a receipt, moves a receipt, invents historical cash, or automatically refunds credit. Cash refunds retain their separate authorized workflow and shift/period rules. `readDebtPosition` delegates its invoice branch to this adapter, and correction source fingerprints include the receipt-sensitive proof.

Verification: `__tests__/postgres/invoice-settlement-position.test.ts` covers multiple corrections, original/ancestor receipts and refunds, unchanged-net proof invalidation, foreign ownership/currency and corrupt lineage refusal. Explicit-visit tests additionally recover an original creation command after two corrections relink the same visit, refusing an unrelated replacement. Combined reception walkout/operational-checkout proof wiring and the no-additional-fee signature journey belong to the later coordinated reception integration.
