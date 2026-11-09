# M2 slice 96 — the service catalogue, prices and service materials on the canonical runtime (2026-11-09)

Owner decision G4-3 (6648682456). The contract is section 15 of the [Group 4 design](financial-group4-contract-design-20261104.md), written before the code. Work branch `feat/agy-work-continuation-20261109`, based on WORK `8586f991`. It was written by the stand-in agent (Antigravity) while Claude's account is paused. No merge, no deploy, no grant to any real account.

## Routes

| Route | Legacy | Canonical |
|---|---|---|
| `GET /api/services` | the money labels; doctors only with the `canViewServicePrices` flag; the money-handling labels also got `invoiceQuotes` | `finance.service-prices.view` gives the legacy body. `invoiceQuotes` need `finance.invoices.create` as well. Without the price grant the request is refused (403), never answered with blanked prices. |
| `GET /api/services?catalogue=1` | — (the legacy path ignores the parameter) | **G4-3:** the price-free clinical catalogue for `clinical.visits.document`. It lists active services through the allowlist `id, name, category, sortOrder`. It carries no price, cost, configured/provisional flag or FX field, and it grants no financial or price-editing authority. |
| `POST /api/services` | admin label | `finance.service-prices.edit`; the legacy validation and body; `service.create` audited in the same transaction |
| `PATCH /api/services/[id]` | admin label | `finance.service-prices.edit`; the row is locked before the audit's before-state is read; `service.update` is audited in the same transaction |
| `POST /api/services/prices` | admin label | `finance.service-prices.edit`; all or nothing; the rows are locked in id order and the previous prices read under those locks; `services.price_batch` and `service.prices.batch` are audited in the same transaction |
| `POST /api/services/provisional` | admin label | `finance.service-prices.edit`; the catalogue is locked in id order and the fills computed from it; only the rows actually written are counted and audited |
| `GET /api/service-materials` | the proxy's clinic labels (the handler checks no role) | `finance.cost-prices.view` (the map) |
| `POST`/`DELETE /api/service-materials` | the inventory labels | `settings.operational.edit` (the map); the service and the item are held `FOR SHARE` (active) until the link commits; the audit is in the same transaction |

Role labels and the legacy `permissions.canViewServicePrices` flag decide nothing on the canonical path. The catalogue dependency (`finance.service-prices.edit` requires `finance.service-prices.view`) makes every editor a price viewer, so the legacy response bodies are kept for writes. The legacy paths keep their behaviour, except for the shared fix below.

## Defects found and fixed (failure first)

1. **The provisional fill over-reported (shared writer; legacy and canonical).** `fillProvisionalServicePrices` returned `filled: fills.length`. The legacy route also audited every computed fill, even when the writer's guard (`WHERE NOT price_configured`) skipped a service. That happens when a service is priced by hand between the route's list and the write. The audit then claimed a provisional price that was never written.
   - Fix: the writer returns `applied`, the rows actually written (`RETURNING`). `filled` counts only those, and the legacy route audits `applied`.
   - Evidence: the test `legacy provisional fill (shared writer fix)` **failed on `8586f991`** (`filled: 2` for one row written) and passes with the fix.
2. **The batch audit's "before" could be stale (canonical path).** The legacy route read the previous prices before the transaction and before the row locks. A concurrent price change would be recorded with the wrong "before".
   - Fix: the canonical batch takes the previous prices from `priceServiceBatchOn`, read under its `FOR UPDATE` locks in id order. The fixed id order also removes a deadlock between two concurrent batches.
   - Evidence: with the legacy pattern restored temporarily, the race test failed: the audit recorded 9100 instead of the committed 9300. With the fix it passes.
3. **A material link could land on a service being deactivated (canonical path).** The legacy route checked the service with an unlocked read. The FK check takes only `FOR KEY SHARE`, which does not conflict with a non-key update.
   - Fix: the canonical writer holds the service and the item `FOR SHARE ... AND is_active`. A deactivation that commits while the link waits makes the link refuse.
   - Evidence: with the unlocked check restored temporarily, the race test failed. With the fix it passes.
4. **Audit atomicity (canonical path).** Legacy wrote every service audit after commit, and the writers' summary rows fire-and-forget (`void recordAudit`). On the canonical path every audit row commits with its write. A test with a refusing audit trigger proves a full rollback.

## Tests

| Gate | Result |
|---|---|
| PG `services-canonical` (local PostgreSQL 18.6) | 11/11 |
| Failure-first | legacy fill test failed on the base and passes; both race tests failed with the legacy patterns and pass |
| PG neighbours (`lab-canonical-pricing`, `plan-reminders-canonical`, plus the invoice/plan suites that use `listServicesWith`/`getSettingsWith`) | see the progress log for the exact run |
| tsc / lint / audits | see the progress log |
| Built-app HTTP journey and browser | not yet written for this slice. It is listed as remaining in the progress log; this slice is **not** claimed accepted without it. |

The 11 PG tests cover:
- reads by grant: invoice quotes only with the invoice grant; inactive services only with `all=1`;
- the priced list refused for the documenter, the cost grant, a money label and the materials editor;
- the catalogue allowlist (exact keys, no price-like text, active only), refused for the price grant, a label and the cost grant;
- revocation of the price grant;
- create and update with the actor's audit, five non-editors refused for both, validation and 404 writing nothing;
- an audit-refusal trigger rolling back the update, the batch and the material link;
- the batch: all-or-nothing, duplicate and zero refused, and the row-lock race recording the committed "before";
- the provisional fill (only unpriced active rows, audit equals the written rows, refusal when nothing is left, a viewer refused);
- the legacy writer fix;
- materials: cost-grant read, set and remove with audits, non-grants refused, inactive service/item and zero quantity refused, 404, and the deactivation race.

## Not changed

- The legacy `GET /api/service-materials` handler still has no role check of its own; the proxy admits the clinic labels. Narrowing a legacy path is outside this slice ("never wider than legacy" applies to the canonical side). It is recorded for the owner.
- No canonical UI was added. The canonical visit screen can now call `?catalogue=1`; wiring the picker is a separate UI slice.
