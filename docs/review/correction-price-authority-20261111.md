# Price and discount authority on financial corrections (2026-11-11)

Answer to the review request on #483 (comment 6801961109). Scope: the canonical runtime on `feat/claude-work-continuation-20261110` (PR #536), inherited from #506 at `8586f991`. Synthetic data only; no Production or Staging access; nothing merged or deployed.

## 1. What was found

Both findings were confirmed by reading the code and then by tests that fail on the previous code.

| # | Path | Finding | Kind |
|---|---|---|---|
| 1 | Issued invoice correction, `POST /api/invoices/[id]/correct` (`commandCanonicalInvoiceRevision` → `reviseInvoiceOn`) | With `finance.invoices.correct` alone, the writer accepted any new unit price (above or below the catalogue) and any discount, with no limit. The same account is refused these values on a new invoice, where `finance.price-increases.apply`, `finance.discounts.apply` and `finance.discounts.override` decide (owner decision G4-1, slice 93b). | Implementation defect: an approved grant boundary could be bypassed by issuing at the catalogue price and then correcting. |
| 2 | Historical document correction, `POST /api/patients/[id]/historical-documents/[documentId]/correct` (`commandCanonicalHistoricalCorrection` → `correctHistoricalDocumentOn`) | With `patients.history.correct`, `finance.opening-balances.manage` and `finance.patient-ledger.view`, the writer accepted new line prices and a new discount without the price grants. Recording the same document does apply them (slice 95c). | Same defect. The opening balance itself is covered: it needs `finance.opening-balances.manage`. |

The legacy routes are not affected: both corrections are for the administrator label only there, and the administrator label holds every price authority on legacy. They are unchanged.

The existing tests did not show the defect because they correct a manual line (no catalogue service) on the invoice path and keep the prices on the historical path. Neither test was changed; both still pass.

## 2. What is implemented

One rule for both paths, on canonical sessions only: **the correction grant is not a price exception. What the correction actually changes in line prices and in the discount, compared with the values stored under the writer's locks, is decided by the price grants of G4-1.** The decision is made after the locks and the stale-source check and before any write. It does not depend on the name of the operation or on which fields the request carries.

This applies the policy the owner already approved for new invoices. It does not introduce a new financial policy. The points where a choice exists are listed in section 4 and are implemented in the stricter direction until the owner decides.

| Operation | What changed, against the stored value | Required before | Required now |
|---|---|---|---|
| Invoice correction | Nothing in money: descriptive or identity change, quantity, removing a line | `finance.invoices.correct` | `finance.invoices.correct` (unchanged) |
| Invoice correction | A line price kept as stored, even when it differs from the catalogue | `finance.invoices.correct` | `finance.invoices.correct`: decided and audited when it was set, not decided again |
| Invoice correction | A line price changed to the catalogue price | `finance.invoices.correct` | `finance.invoices.correct` |
| Invoice correction | A line price changed to above the catalogue | `finance.invoices.correct` | plus `finance.price-increases.apply` |
| Invoice correction | A line price changed to below the catalogue, within `billing.max_discount_percent` | `finance.invoices.correct` | plus `finance.discounts.apply` (or override) |
| Invoice correction | A line price changed to below the catalogue, beyond the limit | `finance.invoices.correct` | plus `finance.discounts.override` |
| Invoice correction | Invoice discount changed (a different amount, or the same amount on a smaller total) and not zero, within the limit | `finance.invoices.correct` | plus `finance.discounts.apply` and the written discount reason |
| Invoice correction | The same, beyond the limit; or changed line discounts and invoice discount together beyond the limit | `finance.invoices.correct` | plus `finance.discounts.override` |
| Invoice correction | Invoice discount removed | `finance.invoices.correct` | `finance.invoices.correct` |
| Invoice correction | Currency changed, or the line's service changed | `finance.invoices.correct` | every line and the discount are decided again in the new currency or for the new service |
| Invoice correction | A manual line lowered below its fixed reference (approved rule 3) | `finance.invoices.correct` | plus `finance.discounts.apply` within the limit measured against the reference; `finance.discounts.override` beyond it |
| Invoice correction | A manual line returned exactly to its reference | `finance.invoices.correct` | `finance.invoices.correct` |
| Invoice correction | A manual line raised above its reference, or first priced from zero | `finance.invoices.correct` | plus `finance.price-increases.apply` |
| Invoice correction | A manual line with a currency change, or with an unprovable reference | `finance.invoices.correct` | plus `finance.price-increases.apply` and `finance.discounts.override` together (full price authority) |
| Historical correction | Paid-before amount, date, note, schedule; prices and discount kept | correct + opening + ledger | unchanged |
| Historical correction | A line price changed above the catalogue | correct + opening + ledger | plus `finance.price-increases.apply` |
| Historical correction | A line price changed below the catalogue, or a changed discount, within the limit | correct + opening + ledger | plus `finance.discounts.apply` |
| Historical correction | The same beyond the limit | correct + opening + ledger | plus `finance.discounts.override` |

Other controls:

- **Reason.** The correction's written reason (3–300 characters, already mandatory) is the reason of each changed line price. A changed discount keeps its own mandatory discount reason.
- **Discount limit.** `billing.max_discount_percent`, read under the settings lock in the same transaction. Percentages are rounded to 0.1 as on new invoices.
- **Re-proof.** The actor re-proves, at the writer's existing points (start, after the locks, before commit), the correction grant and every price grant the decision relied on.
- **Withdrawal during the operation.** An admitted operation holds its account row, so a change to the account's grants waits until the operation ends (measured: the withdrawal did not complete while the writer waited for the patient row). The correction therefore finishes with the grants it was admitted with, and the very next price change after the withdrawal is refused. My first version of this test expected a refusal in mid-flight and timed out; the expectation was wrong, not the runtime.
- **Scope.** Unchanged: decided right after the patient row lock; outside reads exactly like a missing record, before any price decision, so no price information leaks.
- **Refusal.** `unauthorized` (HTTP 403) with the Arabic message that names the missing grant. The whole operation rolls back: no replacement invoice, no revision, no schedule, no opening change, no audit row, and the request key is not consumed.
- **Audit.** The correction's audit row (same transaction) now carries `priceAuthority`: the number of changed lines, whether the discount changed, and each override with its catalogue price, new price and reason.
- **Preserved.** Receipts, collections, vouchers, clinical identities and the immutable lineage are untouched; no cash movement is created; no past amount is recomputed. The replay of a stored correction returns the stored receipt and needs no price grant.

Code: `lib/correction-price-authority.ts` (pure decision), `lib/invoice-revision-db.ts`, `lib/legacy-treatment-document-db.ts`, `lib/canonical-invoice-corrections.ts`, `lib/canonical-history-documents.ts`.

## 3. Tests

Unit, `__tests__/correction-price-authority.test.ts` (12): what counts as a change; each grant; the limit; line and invoice discount together; currency change; manual line.

PostgreSQL, `__tests__/postgres/correction-price-authority-canonical.test.ts`, both paths:

| Scenario | Invoice | Historical document |
|---|---|---|
| Corrector without a price grant: raise, lower, new discount are refused; every financial fact of the patient is byte-identical afterwards | yes | yes |
| Correction that changes no amount is allowed without a price grant | quantity, kept off-catalogue price, kept discount, removed discount, back to catalogue | paid-before amount |
| Corrector with exactly the needed grant is allowed; the audit records the override | increase; discount | increase; discount |
| Discount limit: refused beyond it without the override grant, allowed with it; line and invoice discount measured together | yes | yes |
| A kept discount that becomes a higher share of a smaller invoice is decided again | yes | not applicable (lines cannot be removed) |
| Price grant withdrawn while the writer waits for the patient row: the withdrawal waits for the admitted correction; the next price change is refused and writes nothing | yes | yes |
| Outside the actor's scope: identical to a missing record; nothing written; inside the scope the grants act | yes | yes |
| Retry: a refused key is not consumed; a stored result replays, also after the price grant is withdrawn | yes | yes |

Results are recorded in section 5.

## 4. Rules approved by the owner (2026-11-11) and their implementation

The owner approved the five rules below after the reviewer's recommendations. Earlier revisions of this file listed them as open; they are no longer open.

| # | Approved rule | Implementation | Changed in this revision |
|---|---|---|---|
| 1 | A price moved toward the catalogue that stays below it is checked against the discount grant and limit. Reaching the catalogue price needs no discount grant for that alone. | As approved. | No. |
| 2 | An unchanged discount amount whose share of the total rose is checked again; when its share did not rise nothing more is asked. | As approved. | No. |
| 3 | Manual line without a catalogue price: a reduction is a discount measured against the price recorded before the correction, with the grants and the limit; successive reductions use a fixed reference so the limit cannot be passed in steps. | The fixed reference is the price recorded before the line's **first** correction. It travels in each correction's immutable receipt (`manualPriceReferences`, new corrections only, both paths) and is read under the locks. Lowering below it: discount grant within the limit, override grant beyond it. Returning exactly to it: no price grant. | Yes. `b5c76e71` left manual lines free. |
| 4 | No general exception for a finance manager. The protected owner keeps its authority; reason, audit, voucher and locked-period protections continue. | No exception grant exists. The administrator label alone gives nothing on the canonical path. The protected owner acts with full price authority and is audited. The writer's locked-period, receipt and voucher protections are untouched. | No. |
| 5 | Add previous price, new price, reference and reason to the legacy path's audit for new operations only; older rows unchanged. | Every new correction on both paths writes `priceChanges` in its audit row (same transaction): reason; per changed line the previous price, new price and the reference (`catalogue`, `recorded` or `none`) with its amount; the discount before and after with its reason. The administrator's authority is unchanged; no existing audit row is modified. | Yes. |

### Manual line: remaining cases, decided under the owner's delegation (2026-11-11)

The owner delegated these to engineering judgement ("decide it"). They are decisions of this branch, recorded here with their reasons, and can be changed by a later owner decision without data changes.

| Case | Decision | Reason |
|---|---|---|
| Raising a manual line above its fixed reference | Needs `finance.price-increases.apply`, with the correction reason; recorded as an increase against the reference. | The same control as a catalogue line. Without it a corrector could raise any agreed manual amount with no second control; keeping it stopped would leave a wrongly low line fixable only by the legacy administrator. |
| A manual line recorded at zero | A first price on it is a raise: the same increase grant. Keeping it at zero is not decided. | One rule for every raise; zero is only the lowest reference. |
| Changing the currency of an invoice that has a manual line | Needs the full price authority: `finance.price-increases.apply` and `finance.discounts.override` together. The new price becomes the line's reference in the new currency. Without both it is refused (403) and nothing is written. | Two currencies have no fair comparison without an agreed price, so nothing can be measured; the decision is therefore reserved to whoever has the whole price authority. |
| A reference that cannot be proven (the invoice was corrected before references were recorded) | A price change of that manual line needs the same full price authority; the new price becomes the reference. Keeping the price needs nothing. | Falling back to the stored price would reopen stepwise reductions exactly for those invoices. |

**Owner principle (2026-11-11):** the owner can do everything and gives authority to whom he sees fit. Nothing on this path is closed to the owner: every control above is a grant. The protected owner has all of them; any other account acts only with the grants the owner gave it. The two cases above are not "stopped": they require the two strongest price grants together.

One existing test changed because of these rules: `invoice-corrections-canonical` used a raise of a manual line (10,000 to 14,000) by an account holding only the correction grant as its example of a successful correction. That raise now needs the increase grant, so the test corrects the quantity instead and asserts that the raise is refused. Its other assertions are unchanged.

## 5. Results

First revision (`b5c76e71`): unit 12/12; PostgreSQL 15/15, 12 of 15 failing on the previous writers; related PostgreSQL 25 files, 355/355; full gate green except the three known local browser journeys.

Second revision (approved rules, manual-line decisions, legacy audit detail):

| Check | Result |
|---|---|
| Unit `correction-price-authority` | 18/18 |
| PostgreSQL `correction-price-authority-canonical` (both paths, role matrix, manual line, fixed reference, full price authority) | pass |
| PostgreSQL `invoice-corrections-canonical` (one example changed, see section 4) and `invoice-revision` (legacy administrator, with the new audit assertion) | pass |

Exact counts for the head that carries this revision are in the finance plan file.
