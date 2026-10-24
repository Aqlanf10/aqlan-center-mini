# Invoice editor: «بند يدوي حر» (free manual line) selection fix

UI repair per #451 comment 6386325417. **Not for merge or deployment.**
- Built on the frozen candidate `c998b435`; #451's branch is not written to.
- Synthetic data only.
- No change to pricing authority, server validation, preview or idempotency.

## Defect (reproduced on `c998b435`)

- `ServiceSelect` offered `<option value="manual">`, but passed `Number("manual")`, which is `NaN`, to `onChange(id, service)`.
- The ledger row stored `serviceId: ""` both for "nothing selected" and for "manual". The manual choice therefore could not be represented:
  - the select fell back to the placeholder;
  - choosing manual again ran the empty-service path, which wiped the typed price (`srv = null` gives `price: ""`).
- **Built-app proof on the base build:** right after `selectOption("manual")`, the select's value is `''`, not `'manual'` (2/2 widths fail).

## Fix

| File | Change |
|---|---|
| `components/ServiceSelect.tsx` | The manual line is an explicit controlled state. The props are a discriminated union: `allowManual: true` requires `manualSelected: boolean` and `onManualSelect()`. Choosing manual calls `onManualSelect` and never `onChange`. `onChange` only reports a positive safe-integer catalogue id, or `0` for the empty choice: never `NaN`. Malformed values are ignored. |
| `components/invoice-manual-line.ts` | `selectManualLine(rows, index)`, a pure function. Re-selecting manual keeps the typed description and price. Leaving a catalogue service drops that service's name, price, price reason, doctor and tooth/case linkage. From the empty choice, what was typed is kept. |
| `components/PatientLedger.tsx` | `InvoiceRow.manual?: boolean`. The select is wired with `manualSelected` and `onManualSelect`. A catalogue choice sets `manual: false`. Clearing it also discards catalogue-origin description and price reason before the row loses its service identity; genuinely typed text in the empty choice is retained. Saving is unchanged: the manual line is still sent **without `serviceId`**. |

`PatientLedger` is the only component that offers the manual option. Every other consumer compiles unchanged; the union type makes the manual state mandatory wherever manual is offered.

## Original selection-fix evidence

The original browser results below predate the placeholder/currency follow-up. They do not
prove the newly extended browser path; its current execution status is recorded separately below.

| Suite | Red on `c998b435` | Green |
|---|---|---|
| `__tests__/invoice-manual-line.test.tsx`: the real `ServiceSelect` through the project's hook harness, plus a controlled loop wired like the ledger row | 3 fail (no manual callback; select not held at `manual`; manual ↔ catalogue loop) | 6/6 |
| Existing `service-select-visit-catalog` and `service-select-raw-category` | — | pass |
| `__tests__/security-http/invoice-manual-line-ui.test.ts` (built app, reception, 390 px and 1280 px) | 2/2 fail: `expected '' to be 'manual'` | 2/2 |

**What the browser journey checks:**
1. Choosing manual keeps the select on `manual`.
2. Switching to a catalogue service and back leaves the description and price empty, so no catalogue name or price leaks.
3. Manual re-selection keeps typed description and price. A real YER → SAR → YER change preserves the manual selection/description but clears the amount at each transition, so money is never reinterpreted in another currency. The previous YER → YER action was a no-op, not currency-change evidence.
4. The real preview enables saving.
5. The first `POST /api/invoices` fails at the transport layer before reaching the server; no invoice exists at that point.
6. «إعادة نفس طلب الفاتورة» sends the identical request body.
7. Exactly one invoice is written, its line with `service_id NULL`, the typed description, quantity 1 and unit price 12,345.

The server's validation of manual lines is not changed here. A correct server refusal (for example, a missing price or description) stays distinct from this selection defect.


## Placeholder-path follow-up on PR #459

The remaining catalogue → empty placeholder → manual path was reproduced on
`4b0e1319b4a79c8947fc6a78ec1221e5fd672648`. The actual `InvoiceForm` callback retained
`Synthetic root canal` where the regression expected an empty manual description.
The fix clears the catalogue description while the prior `serviceId` still identifies
its origin, and clears its price reason in the same service-change patch. No name-based
heuristic is used: a user may intentionally type the same words after clearing the choice.

New real-form coverage in `patient-ledger-write-feedback.test.tsx` checks the placeholder
path, no service/doctor/case identity in the manual preview, preservation of typed text,
and amount clearing on YER → SAR → USD → YER changes. The browser journey also covers
catalogue → placeholder → manual and placeholder typing, before its existing same-body
retry and exactly-one-invoice assertions. Server pricing, permissions, pending locks,
preview validation and idempotency paths are unchanged.


Follow-up verification:
- Red actual-form regression on the unchanged PR #459 head: catalogue description survived the placeholder path.
- Green: 155 tests across 13 focused selector/invoice/pricing/preview/command-recovery suites.
- Built-app API-only HTTP checks passed: 19 tests across manual invoice discount/RBAC and clinical linkage/idempotency, on a private synthetic PostgreSQL 18.6 cluster. Harness/server teardown completed.
- Typecheck and optimized Next build passed. The first typecheck exceeded Node's default heap; the serialized larger-heap rerun passed.
- Focused lint passed with no errors and the existing `previewOwner` hook-dependency warning. Build retained the existing migration-files dynamic-tracing warning.
- Expanded Chromium journey is not verified in this environment: the browser smoke test is blocked by Unix-socket `EPERM`, including the supported escalation attempt. No browser workaround or production data was used.
