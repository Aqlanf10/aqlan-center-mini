# 19-crown upgrade after payment: UI characterisation and a multi-item amendment strategy

Per #451 comment 6386297467.
- Test and documentation only. The original characterization was based on `c998b435`; the strengthened checks start from PR #460 head `4b21d71d2422888f01185bb39f07358cbdd1aa0e`. No application code, guard, migration or financial policy is changed here; #451's branch is not written to.
- Synthetic data only.
- **Nothing is fixed here, and the requested case is not declared fixed.**

## Characterized workflows and required assertions (built app, `__tests__/security-http/agreement-amendment-19-crowns-journey.test.ts`)

### New treatment (admin, «علاج جديد»)

**Setup:** one crown service at 50,000 YER; 19 teeth chosen on the shared chart (11–17, 21–27, 31–35). Crowns are a `multi_tooth_episode`.

| Step | What was observed |
|---|---|
| Save invoice | **1 invoice, 950,000**; **19 invoice lines**; **1 plan** with **19 plan items**, each `quantity = 1`, `unit_price_minor = 50,000`, one tooth each. Every line links its own plan item. |
| Consent | Through the plan screen («سجّل موافقة المريض»). |
| Approval | Through «اعتماد أصل الاتفاق المالي», source: the existing invoice. |
| Prior payment | 180,000 through the plan collection endpoint. |
| «ترقية خدمة الاتفاق بفرق مؤرخ» | **API:** `GET` and schema-valid guard-probe `POST`s must return **409**, code `conflict`, «تعدد بنود العلاج يحتاج تخصيصًا ماليًا مستقلًا؛ لا يُخمّن فرق السعر.». The test compares complete stored financial/history rows and cash/commission reader results before and after refusal, rather than just counts and totals. **UI:** the panel shows «البيانات أو الهجرة المالية غير جاهزة؛ لا يمكن حفظ التعديل.» instead (**defect 1**, below). |

### Historical treatment (separate direct HTTP API path, not a browser journey)

| Step | What was observed |
|---|---|
| Direct POST to the historical-document endpoint: one crown episode for the same 19 teeth, agreed 950,000, paid before 180,000 | **1 grouped line** of 950,000 (`episodeTeeth` = all 19), represented by **1 plan item** (quantity 1, 950,000), with **no invoice**. |
| Dated amendment GET and schema-valid guard-probe POSTs | **409**, code `conflict`, «مطلوب اتفاق فعال معتمد ومغطى بفاتورة واحدة مثبتة؛ لم يُنشأ تعديل.» It does not apply to historical agreements. Correction remains the historical workflow. |

**Consequences:**
- The earlier passing amendment tests seed **one** plan item with `quantity = 10` directly. They prove the arithmetic, **not** this journey.
- A separate explicitly named new-treatment API test uses the real invoice, consent, financial-approval and payment endpoints. It does not seed a plan or item directly, and is not a replacement for the browser UI journey.
- The requested case cannot be inferred from the words "19 crowns": a new treatment produces 19 per-tooth items, while a historical one produces one grouped episode.
- Moving a quantity of 19 onto one tooth to get past the guard would misrepresent the teeth, and is not a solution.

## Defect 1: the amendment panel hides the server's refusal

`AgreementAmendmentPanel` throws away any non-OK preview and shows a fixed «البيانات أو الهجرة المالية غير جاهزة». As a result, the real reason (several items, no approved invoice, and so on) never reaches staff.

**Proposed small fix, not applied here:**
- show the server's Arabic `message` for 4xx previews;
- keep the generic text for 5xx or a malformed body;
- with a test that pins both cases.

## Multi-item amendment strategy (proposal; needs the owner's decisions before any code)

**Goal:** upgrade the service and price of several signed per-tooth items after payment. This must:
- keep the signed history (no item is merged or rewritten);
- keep per-tooth attribution, doctor, commission and financial links;
- add a dated difference;
- refuse atomically whenever anything is ambiguous.

**Steps:**
1. **Explicit selection.** The operator selects the affected plan items: all 19, or a subset. The server re-reads them under lock, together with the approved agreement, the source invoice and the same-source receipts. Nothing is ever inferred from the phrase "19 crowns".
2. **Per-item quote.** For each selected item: `delta_i = (new_unit_i − old_unit_i) × quantity_i`, where the item keeps its tooth, case and doctor. One new service and unit price applied to every selected item is the default. Different prices per item require an explicit price for each item, never a spread or a guessed split.
3. **Atomic refusal** of the whole request if any selected item:
   - is cancelled;
   - is billed outside the approved invoice;
   - already has an amendment chain out of order;
   - has a doctor different from the one the operator confirmed;
   - or if the total delta is not positive, the source hash is stale, or the agreement or invoice no longer match.
4. **Recording.** One amendment set holds N amendment rows, one per item, each linked to its own plan item and to its own line in the delta invoice.
   - The current schema has `agreement_delta_amendments.delta_invoice_id UNIQUE`, so one delta invoice cannot serve N rows. That means **either** a new migration (an amendment-set table, with the uniqueness moved to the delta line) **or** one delta invoice per item. One invoice per item keeps the schema, but produces 19 small invoices.
   - Any schema change would come with its own compatibility, locking and roll-forward plan, and would not be run on Staging or Production.
5. **Commission and collection.**
   - Each delta line carries the original item's doctor, so commission follows existing rules on the difference only.
   - The original invoice, its receipts and its commission are never rewritten.
   - Collection uses the existing split-collection path across the original and delta invoices.
6. **Historical grouped episodes** stay out of this path: the episode is a single historical fact. Any revision of it is a historical correction, not a dated upgrade.

## Decisions for the owner (nothing is activated before them)

| # | Decision | Options |
|---|---|---|
| D1 | Which items may be upgraded | all items of the episode only / any explicit subset |
| D2 | How the difference is recorded | one delta invoice for the set (new migration) / one delta invoice per tooth (no schema change) |
| D3 | Items already delivered or signed as completed | refuse / allow as a dated price difference only |
| D4 | One price for all teeth or different prices | one price only / explicit per-tooth prices allowed |
| D5 | Doctor and commission on the difference | always the original item's doctor / an explicit, confirmed doctor |
| D6 | Show the real refusal reason in the panel (defect 1) | yes (recommended) / keep as is |

## Exact refusal proof, not a generic failure

- Both unsupported-source cases must return exactly HTTP `409` and `{code: "conflict", message: <the exact Arabic refusal above>}` for GET and POST. An authentication error, stale-source result, malformed request or HTTP 500 cannot satisfy these assertions.
- A supported preview hash **cannot be obtained** for either refused source: `snapshot()` rejects the source shape before producing its hash. The POST checks are therefore explicitly labeled schema-valid guard probes, not valid preview-backed upgrade commands. Two distinct well-formed nonzero SHA-256 probe values must produce the same exact source-shape refusal. A malformed-hash control must instead return HTTP `400` / `invalid`. No stale-rejection row may be added.
- Historical creation must return one document line linked to one actual plan and one actual plan item, with exactly the 19 selected teeth, a 950,000 YER grouped value, historical paid 180,000 and remaining 770,000. These facts are re-read after creation. A missing plan fails the test instead of silently skipping the amendment check. No current payment receipt or cash movement is fabricated for the historical paid fact.
- Refusal immutability compares full rows for invoices and invoice items; payments; plans, items and installments; financial approvals; amendment events, stale rejections and collection receipts; historical documents, revisions, agreements and tooth coverage; opening balances and their history; repayment arrangements/revisions; and the fixture doctor's commission history. It also compares the complete cash-drawer endpoint result and that patient's commission-detail lines and totals. New-treatment commission assertions require nonempty positive accrual and earned amounts. This is scoped evidence, not a claim that every unrelated table in the database was inspected.

## Evidence and limits

- The runtime record is written to `.settings-ui-artifacts/agreement-amendment-19-crowns.json`. It marks a scenario `passed` only after all its assertions complete; file existence alone is not proof. It contains synthetic aggregates, refusal bodies and source/test provenance, not raw patient rows, database URLs, sessions or credentials.
- The observed local run at **2026-10-24 18:39 UTC** is retained in [2026-10-24-api-evidence.json](2026-10-24-api-evidence.json), copied unchanged from the test output after checking both API scenarios passed and the recorded test-source SHA-256 matches the tested file. The original ignored artifact was not durable hosted evidence and does not prove these strengthened assertions.
- Exact focused command: `npm run test:security-http -- __tests__/security-http/agreement-amendment-19-crowns-journey.test.ts -t 'direct HTTP API'`. Result: **2 passed, 1 not selected**, exit 0. Both selected cases ran against the real built standalone app and a disposable loopback PostgreSQL cluster, which was stopped afterward. The unselected case is the browser journey, not another API case.
- Browser limitation: the local runtime's Chromium launch was verified unavailable (`EPERM` creating a Unix socket, including the supported escalation attempt). No browser workaround was used. The browser assertions remain enabled in the default, unfiltered suite and require CI validation; this local record does **not** prove the UI journey or the generic-message rendering.
- Local `npm run build`, final `npm run typecheck` and focused ESLint passed with Node 22.23.3. The build retained the existing dynamic-filesystem tracing warning in `lib/migration-files.ts`. An initial standalone typecheck hit the default 2 GB heap limit; the serialized 4 GB check passed. No full security-HTTP suite or Production test is claimed.
- Observed synthetic new-treatment values: one 950,000 YER invoice, 19 linked per-tooth items, one 180,000 YER cash receipt attributed to the approved invoice (`payments.plan_id` is null on this path), and unchanged commission accrual 190,000 / earned 36,000. Historical paid 180,000 remains a document fact with zero current payment receipts.
- The browser case preserves the frozen UI's generic-error assertion. A separate UI fix must update that assertion when composed; this test-only branch does not change the panel.
- D1–D5 remain an unimplemented proposal awaiting the owner's decisions. No claim here means the multi-item upgrade is fixed, and no Staging or Production validation was performed.
