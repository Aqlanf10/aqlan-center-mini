# M2 slice 85 — visit documentation: save and addendum (2026-11-04)

Design: [visit documentation contract](visit-documentation-contract-design-20261104.md) §3. Signing is slice 86 (with the owner's decisions 6629149113).

## Route

`POST /api/visits/[id]/clinical`, actions `save` and `addendum`, on one admitted `clinical.visits.document` transaction. The visit is inside the scope by the queue read's condition; outside is 404.

## Who documents what (never wider than legacy)

| Actor | Legacy label | Canonical rule |
|---|---|---|
| Clinician-linked account, or the protected owner | doctor / admin | Any day: notes, the treating doctor, procedures |
| Any other documenting account | assistant | Today's visits only, notes only; the doctor and the procedures unchanged (403). The rule precedes body validation |
| Addendum | doctor / admin / assistant (today) | The same actor rule; `clinical.visits.document` only, as the approved map's `addendum` branch says. The design's first version wrongly added `clinical.visits.sign`; corrected |

## Prices (owner rule 6615124926; the approved map's `priceOverrides` fields)

- **No price sent.** The server price applies:
  - an **unchanged saved line** keeps its saved price, already decided and audited when it was set;
  - a **new line** takes the catalogue price.
  - Without this, a doctor who cannot see prices would silently undo an earlier authorized discount by re-saving, or be refused for someone else's discount.
- **A sent price** is decided by grants (`decideProcedurePriceByGrants`), never by a role label:

| Price change | Required |
|---|---|
| Discount within `billing.max_discount_percent` | `finance.discounts.apply` + a reason |
| Discount beyond the ceiling | `finance.discounts.override` |
| Price above the catalogue | `finance.price-increases.apply` + a reason |
| Manual price for an unpriced service | `finance.price-increases.apply` + a reason (narrower than legacy) |

- Each accepted override writes `visit.price_override` in the same transaction.
- The response is the projected cockpit read: no money without `finance.invoices.view`.

## Refused, never guessed (409, Arabic)

- **Signing:** slice 86.
- **A change of the visit's billing currency:** a financial decision, group 4. An unchanged currency is accepted.
- **A lab draft inside the save:** the lab identity layer still re-authorizes a legacy session. A canonical actor binding for it is separate work; the lab order itself is canonical since slice 68.

## Code

- **`setVisitProceduresOn`** is the legacy body on a caller-owned transaction. The legacy `setVisitProcedures` wraps it with the same commit/rollback outcomes. The query-protocol unit test runs the exact extracted body.
- **`addVisitAddendumOn`.**
- **`lib/canonical-visit-documentation.ts`.**
- **`components/CanonicalVisitClinical.tsx`:**
  - notes form;
  - procedures from the remaining planned work, and removal;
  - addendum form with a request key;
  - prices only when the server returns them.

## Tests

| Gate | Result |
|---|---|
| PG `visit-documentation-canonical` | 6/6 (save; each price grant and refusal, audited; kept price vs catalogue; the documenting-account rule; sign/currency/lab/signed/outside/no grant; addendum with replay) |
| Legacy PG touching the writers | 43 files, 510/510 |
| Related unit suites | 9 files, 122/122 |
| Journey `canonical-visit-documentation-journey` (offset 144) | in the batch gate |
| tsc, lint | clean |
