/**
 * (P2-10) ربط توريد المخزون بفاتورة المورّد — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0017_stock_supplier_link.sql` حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * إدخال مخزونٍ مُشترى من مورّدٍ مسجَّل يحمل جهته والتزامه (payable) الذي وُلد معه في
 * المعاملة نفسها: فلا يُسجَّل الشراء مرتين يدويًّا (مرةً في المخزون ومرةً في
 * المستحقات)، ولا تُنسى فاتورة المورّد. والالتزام الواحد لحركةٍ واحدة.
 */
export const STOCK_SUPPLIER_SQL = `ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS payable_id INTEGER REFERENCES payables(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_payable_uniq
  ON inventory_movements (payable_id) WHERE payable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_movements_party_idx
  ON inventory_movements (party_id) WHERE party_id IS NOT NULL;`;
