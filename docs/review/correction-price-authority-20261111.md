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
| Invoice correction | A manual line without a catalogue service | `finance.invoices.correct` | `finance.invoices.correct` (no reference price exists; as on a new invoice) |
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

## 4. Open questions for the owner

These are policy choices. The stricter option is implemented until decided; none is treated as approved.

1. **Moving a price toward the catalogue.** A stored price of 7,000 against a catalogue of 10,000 corrected to 8,500 reduces an earlier discount, but 8,500 is still a 15% discount. Implemented: it needs the discount grant, and the override grant beyond the limit, like any new price. Alternative: allow any change that moves toward the catalogue price with the correction grant alone.
2. **An unchanged discount amount while lines change.** Implemented: decided again only when its share of the total rises. When the total grows, the kept discount is not decided again. Alternative: decide the discount again on every correction that changes any amount.
3. **Manual lines without a catalogue service.** They have no reference price, on a new invoice and on a correction alike. Implemented: free, as on a new invoice. Alternative: treat a decrease against the stored price as a discount that needs the discount grant.
4. **A separate exception.** Should one grant (for example a finance manager's) be allowed to correct prices without the three price grants? Implemented: no exception exists.
5. **Legacy administrator path.** Unchanged: the administrator label corrects prices freely, with the mandatory reason. Should the same recorded `priceAuthority` detail be added to the legacy audit row? Not implemented; it changes no authority.

## 5. Results

| Check | Result |
|---|---|
| Unit `correction-price-authority` | 12/12 |
| PostgreSQL `correction-price-authority-canonical` | 15/15 |
| Failure-first: the same file against the previous writers (four files restored byte for byte afterwards) | 12 of 15 fail (every refusal and every audit assertion); the 3 that pass are the manual line and the two scope tests, which the previous code already satisfied |
| Existing tests | `invoice-corrections-canonical` and `history-documents-canonical` unchanged |
| tsc, lint | clean |

The related PostgreSQL regression and the full gate are recorded in the finance plan file with the commit.
