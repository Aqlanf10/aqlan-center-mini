# Daily clinic close — invoice-first and pre-system treatment (synthetic)

All files come from the built app rendering the synthetic fixture
`__tests__/fixtures/daily-clinic-report.ts`; no clinic record.

- `daily-clinic-invoices-1280.png`, `daily-clinic-invoices-390.png`: full page, RTL, no horizontal page scroll.
- `daily-clinic-invoices-a4.pdf`: A4 landscape print (7 pages, regenerated on the integrated head). Pages 5–6 hold the
  invoice and pre-system sections (`pdf-page-5-invoices.png`, `pdf-page-6-legacy.png`).
- The invoice and legacy panels are placed after #289's own sections so #289's pagination and its A4 print proofs are unchanged.

Shown in the fixture:
- invoice 900: one RCT line (plan item 3001, case 4001, tooth 36), receipt 502 explicitly on the invoice, corrects 899;
- invoice 901: mixed (crown line + financial-only line); receipts are never split across cases;
- invoice 880: an older invoice whose only line bills a procedure recorded in today's visit #1 — labelled
  «إجراءات زيارة مسجّلة (بلا بند خطة)» / «إجراء مسجّل في الزيارة #1», not «فاتورة مالية بلا بنود علاجية» (review 5461818993);
- invoice 899: cancelled, net 0, corrected by 900 (from the stored `invoice.correct` audit row);
- legacy 950: 300,000 agreed / 120,000 paid before the system / 180,000 remaining at start (YER), coverage recorded;
- legacy 951: no recorded coverage → «التغطية غير مثبتة — تحتاج مراجعة».

## Real records (`real-records/`, review 5461818993)

Rendered by the built app from records written through the real HTTP writers on an isolated synthetic database — the
report payload is **not** mocked (`__tests__/security-http/daily-clinic-real-records-ui.test.ts`):

- a patient who arrives today; `POST /api/invoices` RCT tooth 36 (invoice-first: plan item + case); a real 50,000 YER
  receipt on that invoice;
- `POST /api/patients/[id]/legacy-treatments` 300,000 agreed / 120,000 paid before the system → 180,000 opening; then a
  real 20,000 collection on the YER opening.

Files:
- `daily-clinic-real-invoices-{1280,390}.png`, `daily-clinic-real-legacy-{1280,390}.png`: the section as the user sees it.
- `daily-clinic-real-{invoices,legacy}-390-scrolled.png`: on a phone the table scrolls inside its own container (the page
  itself has no horizontal scroll); these show the amount columns after scrolling.
- `daily-clinic-real-a4.pdf` (6 pages, A4) and `pdf-page-5.png`: the invoice and pre-system sections in print.

What the test asserts: the invoice appears once with its plan item, case and tooth (`single_plan_item`); the agreement row
shows 300,000 / 120,000 / 180,000; the patient's only receipts are 50,000 (invoice) and 20,000 (opening) — the 120,000 is
never a receipt or today's collection.
