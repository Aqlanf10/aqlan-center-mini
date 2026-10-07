# INV-LEGACY — «علاج بدأ قبل النظام» (Pre-system / Legacy Treatment)

Status: implemented on `feat/invoice-first-legacy` (stacked on INV-LINK B–D). Companion of
`docs/INVOICE_FIRST_CLINICAL_LINKAGE.md`; the plan item stays the canonical work identity.

## 1. What the owner asked for

A treatment that started **before** the system (typical: an ortho case agreed at 300,000 YER, 120,000 paid before go-live)
is registered from the Patient Account with: clinical service (catalog service → category → specialty, the same
classification as invoice lines), tooth/scope, original agreed amount, amount paid before the system, historical cutoff date,
currency. The system derives `remaining = agreed − previously paid` (300,000 − 120,000 = 180,000).

## 2. Ledger semantics (the money rules)

| Fact | Where it lives | Current-money effect |
|---|---|---|
| Agreed 300,000, paid before 120,000, remaining at system start 180,000, cutoff, currency, who/when | `legacy_treatment_agreements` (new, append-only) | **None** — historical truth only |
| Remaining 180,000 | `patient_opening_balances` (+ a `patient_opening_balance_history` row) written by the **existing engine** | The patient's only current debt from this treatment |
| Previously paid 120,000 | stays inside the agreement row | **No receipt, no payment row, no cashbox/shift movement, no revenue, no commission** |
| Full 300,000 | the plan item price (agreed work, consented) | **Not** a debt and **never invoiced** (item is covered) |

- Paid == agreed ⇒ remaining 0 ⇒ no opening entry (`opening_effect = 'none'`); the item is still covered.
- The historical payment is never deducted twice: the opening is created with the remaining only; the preview statement says
  «الرصيد الافتتاحي = المتبقي فقط» and «لن يُنشأ إيصال للمبلغ المدفوع سابقًا».

### Reuse of the opening-balance engine (no second engine, no second ledger)

`setPatientOpeningBalance` / `clearPatientOpeningBalance` (lib/db.ts) were split into transaction-scoped cores
`setPatientOpeningBalanceInTx` / `clearPatientOpeningBalanceInTx` — same locks (`lockedOpeningBalance`), same `addOnly`
fence, same `expectedBefore` check, same history row (now `RETURNING id`). The public functions are unchanged wrappers.
The legacy workflow calls the cores inside its own transaction and stores the history-row id on the agreement
(`opening_history_id`, `void_opening_history_id`).

Authority is the engine's: whoever may **add** an opening (`openingBalanceAccess`: admin; reception when
`finance.reception_adds_opening_balance` is on) may register a legacy treatment; reception uses `addOnly` (never modifies an
existing opening row). Modifying an existing opening (adding a second agreement's remaining, or reducing it on void) is an
**edit** ⇒ admin only, with a written reason in the history row.

### Openings that already exist in the currency (double-count guard)

An opening row is single per (patient, currency). When the remaining is > 0 and an opening already exists:

- If the opening principal equals exactly the sum of remainings of the patient's **live** agreements that created/increased it
  in that currency ("agreement-owned"), an **admin** adds the new remaining (`opening_effect = 'increased'`, as-of date = the
  earlier date, reason recorded). Reception is refused (`opening_edit_forbidden`, 403) exactly like the engine's add-only rule.
- Otherwise (a manual/imported opening that may already include this treatment) the request is refused for everyone
  (`opening_not_owned`, 409). **Owner decision pending** (§9): an admin "already included in the existing opening" mode.

Period lock (`finance.locked_before`) is honoured for the opening date(s), as in `/api/opening-balances`.

## 3. Clinical linkage (one transaction)

Patient row `FOR UPDATE` (the engine's add fence; serialises with invoice-first, opening adds and a second tab) →
idempotency check → service must be clinical (`lineLinkage`; consultation/x-ray ⇒ `bad_service`) → duplicate checks →
opening via the engine → plan + item → case → agreement row → audit rows → COMMIT.

- **Plan item**: one new plan «علاج بدأ قبل النظام — <service>» via `insertPlanV2InTx` (shared plan core), one item priced at
  the agreed amount, sessions from the request or the specialty template; the plan is consented at once with the note
  «اتفاق تاريخي قبل النظام … لا يُفوتر»; the item gets `billing_status = 'included_in_package'`.
- **Case**: chosen `caseId` (must be open, same specialty) → else the single open compatible case (site-aware for tooth-bound
  specialties, as INV-LINK) → else (ortho) bridge the patient's un-bridged active `ortho_cases` row → else a new
  `clinical_cases` row titled «<تخصص> [— سن N] — حالة بدأت قبل النظام», `origin = 'clinical'`, no responsible doctor, no
  problem text. More than one compatible open case ⇒ `ambiguous_case`. Nothing ortho/endo/prostho is invented (no
  `ortho_cases`, no diagnosis, no canals, no lab order).
- **Labels**: a case is legacy iff a live agreement points at it (`SpecialtyCase.legacy`); `needsAssessment` stays the
  invoice-origin rule and additionally excludes legacy cases, so no «بدء التقييم السريري» next step is produced.
- `createOrthoCase` bridges the single open ortho shell whose origin is `invoice` **or** that carries a live legacy
  agreement, so the doctor's later ortho intake continues on the same case.

### 3b. Tooth / site — the same chart and rules as an invoice line

The legacy form picks the tooth from the shared Dental Chart dialog (`components/dental/ToothSelectionDialog`); there
is no free-text tooth field. The server applies the invoice line's validator, `validateLineSite`, before anything is
written, opening balance included. That means `tooth_required` for tooth-bound services, and endo/implant/extraction
covering one tooth per agreement (several teeth ⇒ `episode_split_required`: register each tooth separately). A
crown/veneer/bridge agreement covers its whole episode: the case `site` is «14، 15، 16», and the plan item carries the
first tooth plus the note «الأسنان: …». Filling surfaces are stored. Ortho/perio take a scope, which becomes the case
site and the plan item note.

## 4. Coverage (no per-visit invoicing of covered work)

- `PLAN_ITEM_LEGACY_COVERED_SQL` = item `included_in_package` **and** a live agreement on it. `PLAN_ITEM_PREBILLED_SQL` is now
  `(pre-billed by a live invoice) OR (legacy-covered)`, so sign-off pricing (`loadPlanItemsForPricing`), the visit preview
  and the workflow's outstanding items all treat a covered session as included (price 0, no invoice line), while sessions,
  progress and provider still advance.
- Lock order is item → agreement: sign-off share-locks the live agreement after the item lock; void locks the item, then the
  agreement, then the patient with `NO KEY UPDATE` (compatible with FK key-share of payments/sign-off).
- Ortho: `ORTHO_CASE_LEGACY_AGREEMENT_SQL` (live agreement on an ortho item in the case's plan or in the bridged specialty
  case) feeds `classifyOrthoAdjustment({ legacyAgreement })` ⇒ `LEGACY_INCLUDED` («شدّة تقويم مشمولة بالعلاج السابق»),
  not `OUTSIDE_CONTRACT`. No 300,000 invoice and no 120,000 receipt exist.
- Invoice-first: issuing an invoice for the same service+tooth while a live agreement covers an unfinished item is refused
  (`legacy_covered`, also in the invoice preview). A new legacy agreement over an open active plan item for the same
  service+tooth is refused (`open_item_exists`).

## 5. Void (admin, reason ≥ 3 chars) — nothing deleted

Releases coverage (`included_in_package` → `unbilled`, audited «يحتاج مراجعة مالية», like invoice cancellation) and corrects the
opening through the engine:

- `created/increased`: requires the opening to still equal the live agreements' sum (else `opening_changed`, 409 — an admin
  edited it manually; review first). New principal = current − remaining. If that is below what was already collected
  against the opening (`payments.opening_currency`, net of refunds — `openingPosition`) ⇒ refused `opening_settled` (409):
  the engine has no safe reversal for collected money; the cashier must refund/correct receipts first. Otherwise the engine
  **sets** the reduced amount (history row with reason) or **clears** it when it reaches 0 (history row `clear`).
- If the item had no completed session, its plan (created for this agreement only) is cancelled with the void reason, so a
  corrected agreement can be registered again; if work already started, the plan stays and later sessions bill by the item's
  rule. Cases, sessions, procedures and the agreement row itself are kept (`status = 'void'`, who/when/why,
  `void_opening_history_id`).

## 6. Schema — migration 0042 (additive)

`legacy_treatment_agreements` (`lib/legacy-treatment-schema.ts` = body of `migrations/0042_legacy_treatment_agreements.sql`,
mirrored in `ensureSchema()` after `INVOICE_LINKAGE_SQL`): patient, plan_item_id, case_id, service id/name, specialty,
tooth, currency, agreed/previously_paid/remaining (CHECK remaining = agreed − paid, paid ≤ agreed, agreed > 0),
historical_as_of, opening_effect (`none|created|increased`, CHECK consistent with remaining and history id),
opening_history_id, note, idempotency key+hash, created_by/at, status `live|void` + void fields (CHECK). Indexes: unique
idempotency key; unique live scope `(patient, service, COALESCE(tooth, 0))`; unique live plan item; patient; case.
Trigger `aqlan_legacy_treatment_agreement_guard`: no DELETE (except the patient cascade), no UPDATE except live → void on the
void columns. No existing table or CHECK is modified (0041 untouched). Added to `RESET_WIPE_TABLES`; counted as financial
footprint in patient delete/merge guards. Contract and preflight disclosure regenerated; migration chain 42.

## 7. Idempotency and duplicate protection

- `idempotencyKey` (`^[A-Za-z0-9._:-]{8,128}$`) + request fingerprint (patient, service, tooth, case, sessions, currency,
  agreed, paid, cutoff, note): same key + same body ⇒ replay (HTTP 200, same agreement, no second opening); different body or
  patient ⇒ 409; a concurrent same-key race is decided by the unique index ⇒ conflict, never a second row.
- Two submissions with different keys for the same work: serialised by the patient lock; the second sees the live agreement
  ⇒ `duplicate_live` (409); the partial unique index is the last line.

## 8. API, UI, tests

- `GET /api/patients/[id]/legacy-treatments` (ledger readers: admin, reception, cashier, accountant; doctor with
  `canViewPatientPayments` on his patient) — list + `access`.
- `POST /api/patients/[id]/legacy-treatments` (FRONT_DESK in the matrix; enforced by `openingBalanceAccess(...).add` before
  reading the body) — 201 new / 200 replay; Arabic 400/403/404/409.
- `POST /api/patients/[id]/legacy-treatments/[agreementId]/void` (ADMIN).
- Audit: `legacy_treatment.create|void` (sensitive) plus `plan.create`, `case.create`, `plan.item_case`,
  `opening_balance.set|clear`, `plan.item_update`, `plan.status` — all in the same transaction.
- UI: Patient Account button «علاج بدأ قبل النظام» → `LegacyTreatmentForm` (clinical services only, tooth, currency, agreed,
  paid before, cutoff, note; live breakdown via `previewLegacyReconciliation`; case preview via the existing
  `/api/invoices/clinical-preview`; double-click safe through its idempotency key). `LegacyTreatmentAgreements` shows the
  historical panel apart from the current balance (admin void with reason). Badges «حالة بدأت قبل النظام» in the Cases tab,
  Plans (item) and Account (plan card; legacy plans are not offered as payment targets), and `LegacyCaseBanner` in the
  ortho, endo and lab/prostho tabs. Responsive (390px without horizontal page overflow).
- Tests: `__tests__/legacy-treatment.test.ts` (unit), `__tests__/postgres/legacy-treatment.test.ts` (PG18 scenarios),
  `__tests__/security-http/legacy-treatment-http.test.ts` (built app), `__tests__/security-http/legacy-treatment-ui-journey.test.ts`
  (Playwright).

## 9. Limits and owner decisions

1. **Manual opening already present in the currency** ⇒ refused (`opening_not_owned`). Option for the owner: an admin-only
   "remaining already included in the existing opening" mode (link without changing the opening, guarded by
   sum(live remainings) ≤ opening).
2. **Void after collection** beyond what stays covered ⇒ refused (`opening_settled`); refunds/receipt corrections first.
3. Payments still target the opening (per currency), not a specific agreement: with several agreements in one currency the
   collected amount is not allocated per agreement (same as the existing opening model).
4. The plan item is priced at the full agreed amount (agreed work); progress counters ("بقي العلاج") show work, not debt.
5. Historical session count is not inferred: sessions come from the request (API `sessions`) or the specialty template.
