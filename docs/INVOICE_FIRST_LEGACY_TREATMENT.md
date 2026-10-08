# INV-LEGACY — «علاج بدأ قبل النظام» (Pre-system / Legacy Treatment)

Status: on `feat/invoice-first-legacy` (PR #285, stacked on #274/#278). Companion of
`docs/INVOICE_FIRST_CLINICAL_LINKAGE.md`; the plan item stays the canonical work identity.
This guide describes the **current** contract. It replaces an earlier draft that was dropped from the branch during a
composition, and it corrects that draft where the code has since changed: the plan is no longer consented automatically,
coverage is an immutable snapshot (0043), void has two levels, and the form has its own preview.

## 1. What is recorded

A treatment agreed before go-live (example: 300,000 YER agreed, 120,000 paid before the system) is registered from the
Patient Account with these fields:

- the clinical service (catalog category → specialty, the same classification as invoice lines);
- the tooth/site, chosen from the shared Dental Chart;
- the original agreed amount;
- the amount paid before the system;
- the historical cutoff date;
- the currency.

The only derived number is `remaining = agreed − previously paid` (180,000).

| Fact | Where | Current-money effect |
|---|---|---|
| Agreed, paid before, remaining at start, cutoff, currency, who/when | `legacy_treatment_agreements` (0042, append-only, guarded by trigger) | None. Historical facts only. |
| Covered site (teeth/scope/surfaces) | `legacy_treatment_coverage_snapshots` (0043, immutable, captured only at registration) | Prevents billing the same work twice. |
| Remaining 180,000 | `patient_opening_balances` + history row, through the existing opening engine | The patient's only current debt from this treatment. |
| Paid before 120,000 | Only in the agreement row | No receipt, no payment row, no cashbox/shift movement, no revenue, no commission. It is not today's collection. |
| Full 300,000 | Plan item price (`included_in_package`) | Not a debt and never invoiced. |

Currencies stay original. A SAR agreement opens a SAR opening balance, and no conversion is invented.

## 2. Clinical consent is not inferred

Registration creates or reuses a plan and a plan item marked «مشمول بالاتفاق التاريخي». It does **not** record clinical
consent: the plan's `consent_at` stays empty, and the audit row says «الموافقة_السريرية: لم تُسجّل بهذا الإدخال». The doctor
documents the actual current consent and reviews coverage before signing a visit. Saving a draft stays possible. No
historical sessions are invented.

## 3. Case linkage

The case is chosen in this order:

1. The case the user chose. It must be open, of the same specialty, and fit the site.
2. Otherwise, the single open case that fits.
3. Otherwise, for ortho, a bridge to the patient's unbridged active ortho case.
4. Otherwise, a new case titled «… — حالة بدأت قبل النظام».

The ortho bridge in step 3 uses the same rule as invoice-first (`createLinkedInvoice`): it bridges only when the patient has
one running, unbridged ortho case whose recorded `arches` equals the requested scope exactly. A different, blank or unknown
scope is refused with `ortho_scope_mismatch` (409) in both preview and save, and nothing is written. The decision is re-made
under the save's locks, so a change after a successful preview is refused too. The schema already allows only one open ortho
case per patient (`ortho_cases_one_open`), so the ambiguity refusal is defensive.

When several open cases fit, the user chooses one. The save refuses `ambiguous_case` until a case is chosen.

## 4. Preview — the save's own decision (LEGACY-FIX)

`POST /api/patients/[id]/legacy-treatments/preview` has the same authority as the save (`openingBalanceAccess(...).add`;
FRONT_DESK in the HTTP matrix) and uses the same request parser.

- It runs `decideLegacyTreatment()` in a `READ ONLY` transaction. This is the same function the writer runs under its locks.
- It covers:
  - service and site rules;
  - prior work and live coverage;
  - the master plan;
  - opening ownership, role and period lock;
  - the unallocated-receipt guard (§5);
  - case resolution.
- It returns `{ refusal, refusalMessage, preview: { case, opening } }`. A predicted refusal comes back as 200 with its Arabic
  reason, and the save still re-decides under its locks.
- It writes nothing: no plan, case, opening, history or audit row.

Root cause of the earlier HTTP 400: the form borrowed `/api/invoices/clinical-preview` with a placeholder price `"1"`, and
that route applies the ordinary invoice price authority. The legacy agreement is not a sale, so its preview now uses the
agreement data instead of an invoice price. The invoice price authority is **unchanged**, and the built-app test asserts
that the invoice preview still refuses the placeholder.

The form enables «احفظ العلاج السابق» only when all of these hold:

- the draft is valid;
- the preview for exactly that draft is ready, with no refusal;
- no case choice is pending.

Older responses are discarded by request key and sequence. The save is double-click safe through its idempotency key.

## 5. Mixed clinic data — an old payment entered as a receipt

Some patients already have an old payment entered as a **general receipt**: no invoice, no plan, no opening currency, and not
fully refunded. Recording «المدفوع قبل النظام» on top of it would subtract the same money twice. In that case:

- Preview and save refuse with `prior_receipts_review` (409), and the message says manager review and settlement are needed.
- The system does not classify a receipt from its note, and it does not reverse, redate or reallocate it.
- Registering with 0 paid before the system is not blocked, because nothing is then counted twice.

An existing manual or imported opening in the currency is refused as before (`opening_not_owned`).

Neither refusal corrects the data automatically.

## 6. Collections after registration

A real collection on the opening balance, such as 20,000 YER through the cashier with `openingCurrency = YER`, is today's
collection:

- the balance goes from 180,000 to 160,000;
- the opening principal (180,000) and the agreement facts (300,000 / 120,000 / 180,000) are unchanged;
- no invoice is created.

## 7. Void — two levels, admin only, nothing deleted

`GET …/[agreementId]/void?mode=ordinary|manager_authorized` returns the financial impact and a `previewToken`. The token is a
fingerprint bound to:

- the actor and the mode;
- the agreement, the opening and its history revision;
- the collection buckets and the period lock.

`POST …/void` takes `{ reason (3–300), mode, previewToken? }`. Both modes:

- correct the opening through the engine (set or clear, with its history row);
- mark the item `needs_financial_review`;
- keep the agreement row (`status = void`, who/when/why), the case and the clinical history;
- create no refund, receipt correction or re-billing.

| Mode | Allowed when | Refusals |
|---|---|---|
| `ordinary` | No net collections on the patient's opening in that currency | `opening_collected` (409) |
| `manager_authorized` | Requires a current preview token of **this** mode. Allowed only while the principal left after the void still covers the net collections (aggregate bound). | `preview_required` (400); `preview_stale` (409) for another mode's token or changed evidence; `opening_settled` (409) |

Both modes also refuse with `already_void`, `opening_changed` and `period_locked`.

## 8. API, UI, audit

- `GET /api/patients/[id]/legacy-treatments`: list and `access`. Admin and reception; a doctor only on their own patients,
  with `canViewPatientPayments`.
- `POST /api/patients/[id]/legacy-treatments`: returns 201 for a new agreement and 200 for a replay, with Arabic 400/403/404/409.
  Idempotency keys match `^[A-Za-z0-9._:-]{8,128}$` and carry a request fingerprint.
- `POST /api/patients/[id]/legacy-treatments/preview`: read-only, §4.
- `GET|POST /api/patients/[id]/legacy-treatments/[agreementId]/void`: ADMIN, §7.
- Audit, in the same transaction:
  - `legacy_treatment.create|void`;
  - `plan.create|item_update`, `case.create`, `plan.item_case`;
  - `opening_balance.set|clear`.
- UI:
  - The Patient Account button «علاج بدأ قبل النظام» opens `LegacyTreatmentForm`, with the shared Dental Chart, the live
    arithmetic, and the preview of the case and opening effect.
  - `LegacyTreatmentAgreements` shows the historical panel apart from the current balance.
  - Specialty tabs show «حالة بدأت قبل النظام» banners.
  - The plan print shows the agreement as history, «ليست دينًا», with the coverage teeth and «الموافقة الحالية غير متحققة».
  - The account statement shows only the 180,000 opening, with no invoice and no receipt.

## 9. Tests

| Layer | Files |
|---|---|
| Unit | `__tests__/legacy-treatment-*.test.ts(x)`; `legacy-treatment-identity-scope` pins that save and preview share `decideLegacyTreatment` and that the preview is read-only |
| PostgreSQL 18 | `__tests__/postgres/legacy-treatment*.test.ts`, including `legacy-treatment-preview` (preview = save, no writes, case choice/bridge, opening per role, SAR, unallocated receipt, refunded receipt, 20,000 collection) |
| Built app (HTTP) | `__tests__/security-http/legacy-treatment-http.test.ts` (registration/replay/conflict/duplicate, Arabic validation, roles 401/403/404, preview vs unchanged invoice price authority, unallocated receipt, collection, ordinary and manager-authorized void with stale and other-mode tokens) |
| Built app (HTTP, review 5451105703/5451120047) | catalog price ≠ historical amount in YER/SAR/USD (catalog 250,000 YER vs agreed 300,000, asserted) registers without a price reason or provider, and the item carries the agreed amount with no provider/consent; catalog price = old placeholder: legacy proceeds while the invoice preview keeps `financialReviewRequired`; an ordinary invoice override still needs its reason; ortho upper vs running lower is refused with no writes, while the matching scope registers |
| Built app (browser) | `__tests__/security-http/legacy-treatment-ui-journey.test.ts`: at 1280 and 390, chart 14–16, preview ready, double-click save, stored rows, no invoice/receipt, no consent, case banner, account, plan and statement PDFs (A4); a failed preview blocks save visibly; A→B→A holds A1, lets B and then A2 answer, and only then releases A1 with a marked copy of its real response — the screen keeps A2's evidence (each step waits on a request/response/paint signal, no sleep; removing the abort, sequence and key guards makes it fail on the marked amount); close/reopen starts empty with no writes |

All tests use isolated synthetic databases only. No production data is used.

**Retained run evidence (review 5461563181).** The browser journey writes its own 1280/390 screenshots (form, saved,
case, account) and the two A4 PDFs (plan, statement) to the CI log as `SYNTHETIC_PRINT_EVIDENCE_V1` BEGIN/CHUNK/END records
(`__tests__/security-http/_synthetic-evidence-log.ts`, scope `legacy-treatment-journey`). Each record carries `acceptance: true`,
the byte count, SHA-256, `GITHUB_RUN_ID`/attempt/ref/sha and the checked-out commit with its parents. Files are accepted only
after all assertions of their width passed, and the set is emitted only when complete, so a failed run never emits an accepted
set. `decodeEvidence()` in the same module rebuilds the files and verifies order, size and checksum. CI gates and upload
steps are unchanged.

## 10. Limits

1. Collections target the opening per currency, not a specific agreement.
2. A manual opening that may already include the treatment is refused (`opening_not_owned`). It needs the manager's review.
3. Old payments entered as general receipts block a non-zero «paid before» until the manager reviews them (§5). This branch
   does not correct existing production records.
4. Historical progress is unknown, so no sessions are inferred from amounts.
