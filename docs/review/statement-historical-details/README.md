# Historical treatment agreements in the CURRENT printed patient statement

- **Base:** #439 head `9881d33c21c4812ae3e18219a8112438d6192a78` (`feat/finance-synthetic-verification-20261023`). Existing PRs are untouched.
- **Branch:** `feat/fin-statement-historical-details`.
- **Assignment:** issue comment 6372880256 on #438. Synthetic data only; no real identifiers or screenshots of real data.

## The gap

The current print passed only `ledger.invoices` to `StatementInvoiceDetails`. A historical multi-item registration writes:
- `legacy_treatment_documents`, plus `legacy_treatment_document_revisions.lines`;
- only the remaining amount, into the opening balance.

It creates no invoices or receipts, so a patient with genuine historical treatment printed «لا فواتير حالية» and nothing else. Nothing here creates invoices or parses opening notes.

## What changed

### `lib/statement-historical-details.ts` (new reader and projection)

`readStatementHistoricalAgreements(client, patientId)`:
- runs on the caller's snapshot client only, with no pool and no transaction of its own;
- issues two patient-scoped queries.

**Documents:**
- It reads the **latest saved revision**: `lines`, with description, site, unit price, allocated discount and net amount, plus the aggregate gross, discount, previously paid and remaining amounts and the historical date.
- It never reads catalogue or plan-item prices, or the child `agreed_minor` values, which are stale after a correction.
- Quantity is exactly 1 per clinical line; tooth counts never become quantities.

**Standalone legacy agreements:**
- Only `document_id IS NULL AND status = 'live'`, so document children are never printed twice and void agreements are not printed.
- The site comes from the immutable coverage snapshot, falling back to the stored anchor tooth.
- There is no discount concept, so the discount column prints «—».

**Fail-closed:** each of these throws `StatementHistoricalDetailsError`, and the print fails rather than showing an empty list or a zero:
- a missing revision;
- a line count mismatch;
- non-numeric or unsafe JSON amounts;
- net ≠ unit − discount;
- totals that do not match the lines;
- remaining ≠ agreed − paid;
- an unknown currency;
- an invalid date.

`historicalOpeningBuckets(agreements, openings, payments)` is a pure projection over the **same snapshot's** opening rows and receipts:
- per currency, current opening collections follow `readDebtPosition`'s rule: payments minus refunds targeted at the opening currency, settled via `settlePaymentMinor`;
- they are counted **once per currency** and never allocated to a document or line;
- `openingWithoutStoredDetail` flags an opening principal that the stored history does not account for. It is reported, never inferred or allocated.

### `app/print/statement/[id]/presentation.tsx`

`StatementHistoricalDetails` reuses the invoice table classes (`items statement-invoice`), so the print CSS applies unchanged: splittable rows, repeated `thead`, and wrapping numbers.
- The heading is «اتفاقات علاج سابقة — قبل بدء العمل بالبرنامج».
- Each table is headed «اتفاق علاج سابق #id — بتاريخ … [— النسخة المصححة N]», or «علاج سابق» for a standalone agreement.
- Columns: treatment, site, quantity, unit price, discount, net.
- Totals:
  - gross;
  - recorded discount;
  - agreed after discount;
  - «مدفوع قبل البرنامج (سجل تاريخي — ليس سند قبض حاليًا)»;
  - «المتبقي عند التسجيل — أُضيف إلى الرصيد السابق».
- Once per currency: «المحصّل منه في البرنامج بعد الاستردادات» and «المتبقي من الرصيد السابق». When there is no opening row it shows «لا رصيد سابق قائم بهذه العملة.». An opening with no stored history shows «تفاصيل العلاج غير مسجلة للرصيد السابق بهذه العملة.».

### `app/print/statement/[id]/page.tsx`

- It renders the section before the invoice details.
- The receipt table, the canonical `ledgerBalancesByCurrency` summary, the agreement blocks and the dated `?to=` path are unchanged.

### `lib/db.ts` `patientStatementSnapshot` (the one coordinated integration)

```diff
     const {rows}=await client.query<PlanRow>(`${PLAN_SELECT} ${PATIENT_PLANS_WHERE}`,[patientId]);
-    return {ledger,planCurrencies,plans:await hydratePlans(rows,today,client)};
+    const plans=await hydratePlans(rows,today,client);
+    // Historical agreements are saved facts read on this same snapshot client (no separate transaction).
+    const historicalAgreements=await readStatementHistoricalAgreements(client,patientId);
+    return {ledger,planCurrencies,plans,historicalAgreements};
```

Plus one import. `listHistoricalDocuments` is **not** called: it opens its own transaction and performs per-document position and correction reads.

**Composition with #444 (`45067c53`):** keep #444's derived `planCurrencies`, `hydratePlans(rows,today,client,true)` and its repayment cache. Add only the `historicalAgreements` read on the same `client` and the extra return field. `lib/plan-financial-position.ts` is not touched.

### Test composition

Three existing unit print tests mock `patientStatementSnapshot`. Their mocks gained `historicalAgreements: []` only; no assertion changed.

## Scope boundary

This change covers only the **current, no-query print**. The dated `?to=` print uses a different report contract and is not a historical database snapshot, so it is unchanged. No latest-revision details are printed beside an old-date balance.

There are no financial writers, no migrations and no changes to accepted currencies or permissions.

## Evidence

`__tests__/postgres/statement-historical-details.test.ts` has 13 cases, all through the real writers and the real page.

**The example case:**
- Gross 500,000, discount 50,000, agreed 450,000, paid before 150,000, opening 300,000.
- Two clinical lines with their allocated discounts.
- No invoices or receipts: billed and collected are 0 and the opening appears once.
- After a current 40,000 receipt and a 10,000 refund:
  - collected is 30,000 and the remainder is 270,000, shown once at currency level;
  - the historical table is byte-identical to the one before the collections;
  - printing writes nothing, checked by a whole-database content hash covering payments, cash shifts, journals, history and audit.

**Further cases:**
- **Multiple same-currency documents:** each is printed once, with one collected/remaining line for the currency, and no child re-printed.
- **Mixed current invoice:** both sections print; invoice receipts are never counted as opening collections.
- **Corrected latest revision:** version 2 prices and paid amount, the «النسخة المصححة 2» label, and stale child `agreed_minor` values not printed.
- **Fully paid historically:** no opening row, remainder 0, «لا رصيد سابق قائم».
- **Standalone and void:** a live standalone agreement prints once with its stored site («الفكّان») and «—» discount; a void one is absent.
- **Manual or imported SAR opening with no detail:** says «تفاصيل العلاج غير مسجلة», infers nothing, and keeps separate YER and SAR buckets.
- **SAR at ×100:** 1,500.50 / 300 lines; no YER bucket appears.
- **Patient ownership:** only this patient's agreements are printed.
- **Concurrency:** a historical correction and an opening payment committed between the receipt listing and the historical read leave the printed sheet byte-identical to the one before. The next print shows both together.
- **Read errors:** a failing historical query fails the print; there is no empty history.
- **Malformed stored facts:** 14 cases, each throwing a typed error rather than becoming empty or zero.

`mutation-sensitivity.log` records five mutations, each caught:
- reading the first revision instead of the latest;
- reading outside the statement snapshot;
- re-printing document children;
- printing void agreements;
- allocating opening collections per document.

`__tests__/security-http/patient-statement-historical-print-ui.test.ts` runs on the built app with real endpoints:
- historical document creation goes through `/api/patients/[id]/historical-documents`; receipt and refund through `/api/payments`;
- one document has 24 lines across A4 pages;
- every page carrying lines repeats the agreement heading and the column headings in the actual PDF;
- each saved line and total is checked in the DOM and in the PDF text, with Arabic normalisation only for pdftotext's lam-alef and shadda output;
- the canonical ledger API is the oracle for the balance;
- PDF word geometry stays on the A4 page, and the description sits right of its amount (RTL);
- doctor gets 404; another patient's history is absent; a tampered `patientId` query gets 404;
- there are no writes.

## Remaining gaps

- The dated `?to=` print shows no historical details. That needs a separate, tested cutoff contract.
- Browser and PDF coverage is YER only. SAR ×100 is covered in PostgreSQL through the real page render.
- Historical facts are shown as saved. Correction remains the existing admin workflow.
