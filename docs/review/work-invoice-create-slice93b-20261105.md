# M2 slice 93b — creating an invoice on the canonical runtime (2026-11-05)

Owner decisions:
- **G4-1:** writing a price needs the write grant matching the act, plus the settled price controls.
- **G4-8:** invoice writes stay inside the patient scope.

The contract was written before the code: section 7 of the [Group 4 design](financial-group4-contract-design-20261104.md).

Scope of this slice: `POST /api/invoices` and `POST /api/invoices/clinical-preview`. Add-service follows in 93b-2, under the same contract.

**The preview** is the registered read `read:invoices.preview` (`finance.invoices.create`). It runs on one snapshot, inside the patient scope (outside reads as missing, 404). Lab-work lines need `clinical.visits.document`. It uses the creation parser and the same price controls by the same grants, so it never promises a price the save would refuse. It returns the legacy body and writes nothing.

## Admission

| Request | Grant |
|---|---|
| Any invoice | `finance.invoices.create` |
| Lab-work lines | Also `clinical.visits.document` (403 `lab_work_not_allowed`) |
| Repayment terms (they create a debt arrangement) | Also `finance.payments.collect` (403 `repayment_not_allowed`) |

View grants and the administrator label never write. The protected owner holds every grant.

## Price controls by grants (G4-1)

`checkInvoiceAuthority` gains an optional `grants`. When given, the role label is ignored:

| Price | Requirement |
|---|---|
| Line below the catalogue, or an invoice discount, within `billing.max_discount_percent` | `finance.discounts.apply` and a written reason |
| Beyond the ceiling, alone or combined | `finance.discounts.override` |
| Above the catalogue (or above a configured zero) | `finance.price-increases.apply` and a reason |
| Service unpriced in this currency | A written reason, no additional grant (the legacy invoice rule) |

The legacy path is unchanged: the same rule and messages for the role label.

The legacy engine re-checks the price authority under the catalogue locks. In the canonical runtime it uses the same grants, read live through the branded **invoice actor**.

## The invoice actor

A module-private brand, minted only by the operation. JSON cannot forge it. It stands wherever the legacy writer revalidated its session:
- the template or catalogue authority;
- the replay recovery;
- the lab-work materialisation, through the slice-87 lab actor;
- the repayment arrangement, through the slice-91 debt actor, which exists only with `finance.payments.collect`.

Each point re-proves the live operation on the same transaction client.

## The writer and the scope

- **Writer:** one admitted operation on `createLinkedInvoiceInTransaction`. Its locks, key, fingerprints, catalogue and template revalidation, lab-work and repayment writers, and `invoice.create` audit (with price overrides) are unchanged.
- **Recovery first:** the lost-acknowledgement recovery runs before anything else, as in legacy (`recoverLinkedInvoiceOn`, which writes nothing).
- **Reads on the operation's client:** the catalogue, doctors and settings are read through the client (`listServicesWith`, `getSettingsInTransaction`), never a second connection.
- **Scope:** decided right after the writer's patient row lock (`admit`), before the replay, every refusal and every write. An `own` actor needs a positive ownership witness, taken `FOR SHARE NOWAIT` and held until commit. An early unlocked look comes first. Outside the scope reads as missing (404).

## Tests

| Gate | Result |
|---|---|
| PG `invoice-create-canonical` | 6/6 (5 creation + 1 preview) |
| Race test failure-first | Without the admission, the outside invoice was written (the test failed). Restored, it passes. |
| Unit `invoice-pricing-grants` | 5 tests (17 with the legacy pricing suites) |
| Audits | 10/10 (map: `POST /api/invoices` `canonical-done` with its field rules) |
| Legacy invoice regression | 38 files, 562/562 (every suite touching the invoice writer, recovery, template validation, price authority, add-service, preview linkage and lab work) |
| Related unit | 15 files, 226/226 |

The 5 PG tests cover:
- the catalogue price, with its audit and replay;
- each price control: discount without its grant, within the ceiling, beyond it, an increase without and with its grant, the label refused, the owner allowed;
- lab work and repayment refused without their grants;
- view grants refused;
- an `own` creator inside versus outside (404), and revocation;
- the race in which the patient leaves the scope during the patient row lock.

No Production, no merge, no activation.
