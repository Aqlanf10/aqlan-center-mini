# M2 slice 93c — archiving, restoring and correcting issued invoices on the canonical runtime (2026-11-05)

Owner decision G4-8 (6648682456): invoice writes stay inside the patient scope.

The contract is section 8 of the [Group 4 design](financial-group4-contract-design-20261104.md). In legacy, all three routes were for the administrator label only. Here the explicit grant replaces the label. The two grants are independent: neither implies the other, and neither the label nor a view grant acts.

| Route | Canonical behaviour |
|---|---|
| `POST /api/invoices/[id]/archive` (archive or restore) | `finance.invoices.cancel`. One admitted operation on the legacy writer `changeInvoiceArchiveOn`. |
| `GET /api/invoices/[id]/correct` | The registered read `read:invoices.correct` (`finance.invoices.correct`) on one snapshot. Outside the scope gives the same message as a missing invoice. |
| `POST /api/invoices/[id]/correct` | `finance.invoices.correct` (a new runtime action, no new capability). One admitted operation on the legacy writer `reviseInvoiceOn`. |

What each writer keeps from legacy, unchanged:
- **Archive:** key lock, replay, lock order, eligibility, period lock, archive event and audit.
- **Correction:** lock order, replay, replacement invoice, settlement lineage with receipts untouched, dated repayment terms through the debt writer, lab-work aliasing, `invoice.correct` audit.

## Common to both writers

- **Actor:** the slice-91 branded actor re-proves the live operation and its grant on the same client wherever the legacy writer revalidated a session.
- **Scope:** decided right after the writer's patient row lock (`admit`). An `own` actor needs a positive ownership witness, taken `FOR SHARE NOWAIT` and held until commit. An early unlocked look comes first. Outside the scope reads as missing.
- **Durable archive rejections** (period locked, policy decision required) still commit their evidence before the refusal.
- **Legacy wrappers** run the same functions in their own transactions; their order and messages are unchanged.

## For the owner

The legacy correction had no price ceiling (the administrator was unlimited). No new price policy is layered on `finance.invoices.correct` in this slice.

**Question:** should a correction also be bound by the discount, override and increase controls (`finance.discounts.apply`, `finance.discounts.override`, `finance.price-increases.apply`)?

## Tests

| Gate | Result |
|---|---|
| PG `invoice-corrections-canonical` | 7/7 |
| Race tests failure-first (archive and correction) | Without their admissions, both outside writes went through (both tests failed). Restored, they pass. |
| Legacy PG (archive, revision, correction and lineage suites) | 24 files, 397/397 |
| Manual-cash suites, each on its own fresh disposable database | 44/44 and 18/18 |
| Related unit | 8 files, 70/70 |
| Audits | 10/10 (GET with its projection) |
| tsc | Pass |
| lint | Clean |

The 7 PG tests cover:
- **Archive:**
  - archive with its audit, replay, then restore;
  - a durable rejection whose evidence is committed;
  - the correct grant, the label and view grants refused.
- **Correction:**
  - read and correct with its audit, receipts untouched, and replay;
  - the cancel grant, the label and view grants refused for both read and write.
- **Scope:**
  - `own` inside versus outside, reading like missing;
  - revocation;
  - two races (archive and correction) in which the patient leaves the scope during the patient row lock.

No Production, no merge, no activation.
