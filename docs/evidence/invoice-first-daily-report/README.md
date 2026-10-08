# Daily clinic close — invoice-first and pre-system treatment (synthetic)

All files come from the built app rendering the synthetic fixture
`__tests__/fixtures/daily-clinic-report.ts`; no clinic record.

- `daily-clinic-invoices-1280.png`, `daily-clinic-invoices-390.png`: full page, RTL, no horizontal page scroll.
- `daily-clinic-invoices-a4.pdf`: A4 landscape print (9 pages). Pages 7–8 hold the invoice and pre-system sections
  (`pdf-page-7-invoices.png`, `pdf-page-8-legacy.png`).
- The invoice and legacy panels are placed after #289's own sections so #289's pagination and its A4 print proofs are unchanged.

Shown in the fixture:
- invoice 900: one RCT line (plan item 3001, case 4001, tooth 36), receipt 502 explicitly on the invoice, corrects 899;
- invoice 901: mixed (crown line + financial-only line); receipts are never split across cases;
- invoice 899: cancelled, net 0, corrected by 900 (from the stored `invoice.correct` audit row);
- legacy 950: 300,000 agreed / 120,000 paid before the system / 180,000 remaining at start (YER), coverage recorded;
- legacy 951: no recorded coverage → «التغطية غير مثبتة — تحتاج مراجعة».
