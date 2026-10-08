/**
 * (FIN-DISC, owner decision: option 2) خصمٌ إداري موزَّع على بنود الفاتورة — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0044_invoice_admin_discount_lines.sql` حرفيًّا.
 * إضافيٌّ خالص: جدولٌ جديد وفهرسه وحارسه؛ لا يمسّ جدولًا قائمًا ولا يعبّئ شيئًا.
 *
 * - كل قرار خصمٍ إداري يُكتب سطرًا لكل بندٍ نال منه جزءًا (`amount_minor`)، بلحظة القرار (`discounted_at`). مجموع أسطر
 *   القرار = مبلغه بالضبط، وخصم الفاتورة (`invoices.discount_minor`) يزيد بالمبلغ نفسه في المعاملة نفسها.
 * - العمولة تُحسب من قيمة البند بعد هذه الأسطر (لا يمسّ خصم الإنشاء القائم)، وبلحظة القرار: ما قُبض قبله لا يُعاد حسابه.
 * - تصحيح الفاتورة ينقل أسطر البنود الباقية إلى بنود الفاتورة البديلة بلحظتها الأصلية (`carried_from_id`).
 * - الحارس: لا تعديل؛ والحذف فقط بتتالي حذف الفاتورة نفسها.
 * التصميم: docs/evidence/invoice-admin-discount/README.md.
 */
export const INVOICE_ADMIN_DISCOUNT_SQL = `CREATE TABLE IF NOT EXISTS invoice_admin_discount_lines (
  id               SERIAL      PRIMARY KEY,
  invoice_id       INTEGER     NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_item_id  INTEGER     NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  amount_minor     BIGINT      NOT NULL CHECK (amount_minor > 0),
  discounted_at    TIMESTAMPTZ NOT NULL,
  carried_from_id  INTEGER     REFERENCES invoice_admin_discount_lines(id),
  created_by       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_admin_discount_lines_invoice_idx
  ON invoice_admin_discount_lines (invoice_id, invoice_item_id, discounted_at);

CREATE OR REPLACE FUNCTION aqlan_invoice_admin_discount_line_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'invoice_admin_discount_lines is append-only';
  END IF;
  RAISE EXCEPTION 'invoice_admin_discount_lines is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER invoice_admin_discount_lines_guard
  BEFORE UPDATE OR DELETE ON invoice_admin_discount_lines
  FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_admin_discount_line_guard();
`;
