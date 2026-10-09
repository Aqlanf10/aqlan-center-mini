/**
 * (INV-LINK B) الربط السريري للفاتورة — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0041_invoice_clinical_linkage.sql` حرفيًّا.
 * إضافيٌّ خالص: أعمدةٌ قابلة للفراغ وفهارس؛ الصفوف القائمة تبقى فارغة (المصدر غير معروف)، بلا تعبئة.
 *
 * - `invoices.idempotency_key/idempotency_request_hash`: إعادة الطلب نفسه تُعيد الفاتورة نفسها، وبجسمٍ آخر ⇒ تعارض.
 * - `plan_items.billed_invoice_id`: الفاتورة الحيّة التي قبلت البند ماليًّا (مع `billing_status = 'billed'`).
 * - `invoice_items.plan_item_id`: بند الخطة الذي يمثّله سطر الفاتورة — يُنسخ إلى سطر الفاتورة المصحَّحة فيبقى النسب
 *   عبر التصحيحات المتتالية (المصدر الفريد `source_type/source_id` يبقى للسطر الأصل وحده).
 * - `plan_items.origin/origin_invoice_id`، `clinical_cases.origin/origin_invoice_id`: من أين جاء العلاج والحالة.
 * التصميم: docs/INVOICE_FIRST_CLINICAL_LINKAGE.md.
 */
export const INVOICE_LINKAGE_SQL = `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS idempotency_request_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_idempotency_key_uniq
  ON invoices (idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS origin TEXT
  CHECK (origin IS NULL OR origin IN ('plan', 'visit', 'invoice'));
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS origin_invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS billed_invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS plan_items_billed_invoice_idx ON plan_items (billed_invoice_id) WHERE billed_invoice_id IS NOT NULL;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS plan_item_id INTEGER REFERENCES plan_items(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS invoice_items_plan_item_idx ON invoice_items (plan_item_id) WHERE plan_item_id IS NOT NULL;
ALTER TABLE clinical_cases ADD COLUMN IF NOT EXISTS origin TEXT
  CHECK (origin IS NULL OR origin IN ('clinical', 'invoice'));
ALTER TABLE clinical_cases ADD COLUMN IF NOT EXISTS origin_invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT;
`;
