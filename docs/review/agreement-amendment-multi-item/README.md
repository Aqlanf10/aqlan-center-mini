# 19-crown upgrade after payment: UI characterisation and a multi-item amendment strategy

Per #451 comment 6386297467.
- Test and documentation only, built on the frozen `c998b435`; #451's branch is not written to.
- Synthetic data only.
- **Nothing is fixed here, and the requested case is not declared fixed.**

## What the real UI creates (built app, `__tests__/security-http/agreement-amendment-19-crowns-journey.test.ts`)

### New treatment (admin, «علاج جديد»)

**Setup:** one crown service at 50,000 YER; 19 teeth chosen on the shared chart (11–17, 21–27, 31–35). Crowns are a `multi_tooth_episode`.

| Step | What was observed |
|---|---|
| Save invoice | **1 invoice, 950,000**; **19 invoice lines**; **1 plan** with **19 plan items**, each `quantity = 1`, `unit_price_minor = 50,000`, one tooth each. Every line links its own plan item. |
| Consent | Through the plan screen («سجّل موافقة المريض»). |
| Approval | Through «اعتماد أصل الاتفاق المالي», source: the existing invoice. |
| Prior payment | 180,000 through the plan collection endpoint. |
| «ترقية خدمة الاتفاق بفرق مؤرخ» | **API:** `GET` and `POST` both return **409** «تعدد بنود العلاج يحتاج تخصيصًا ماليًا مستقلًا؛ لا يُخمّن فرق السعر.». Nothing is written: invoices, plan items, payments and amendments are unchanged. **UI:** the panel shows «البيانات أو الهجرة المالية غير جاهزة؛ لا يمكن حفظ التعديل.» instead (**defect 1**, below). |

### Historical treatment (separate path)

| Step | What was observed |
|---|---|
| Historical document: one crown episode for the same 19 teeth, agreed 950,000, paid before 180,000 | **1 grouped line** of 950,000 (`episodeTeeth` = all 19), represented by **1 plan item** (quantity 1, 950,000), with **no invoice**. |
| Dated amendment | **409** «مطلوب اتفاق فعال معتمد ومغطى بفاتورة واحدة مثبتة؛ لم يُنشأ تعديل.» It does not apply to historical agreements. Correction remains the historical workflow. |

**Consequences:**
- The earlier passing amendment tests seed **one** plan item with `quantity = 10` directly. They prove the arithmetic, **not** this journey.
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

## Evidence and limits

- `agreement-amendment-19-crowns-journey.test.ts` passes on `c998b435`. It **characterises** current behaviour, both journeys and defect 1. It is not a red-to-green fix proof.
- Its JSON evidence is written to `.settings-ui-artifacts/agreement-amendment-19-crowns.json` when run. The figures above come from that file.
