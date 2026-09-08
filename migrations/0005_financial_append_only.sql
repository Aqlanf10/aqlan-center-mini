-- 0005 — Financial Append-Only Integrity (Trigger Guards: UPDATE + DELETE) — P1.6 + P1-FIX-3
-- المبدأ: الحدث المالي التاريخي immutable — لا يُعدَّل ولا يُحذف. التصحيح حدثٌ
-- صريح لاحق (ردّ/تسوية/إبطال)، لا UPDATE صامت يغيّر قيمةً محاسبية وقعت ولا
-- DELETE ي محوها.
--
-- الحرّاس triggers على مستوى القاعدة (تحمي حتى من psql أو أي عميل خارجي):
--
--  * UPDATE guards (P1.6):
--    - payments: الأعمدة المحاسبية كلها محصّنة (amount_minor, currency,
--      exchange_rate, base_amount_minor, base_currency, kind, invoice_id,
--      shift_id, receipt_number, patient_id, idempotency_key,
--      idempotency_request_hash, reversal_of_id). note/created_by metadata
--      غير محاسبية تبقى قابلة للتحديث.
--    - expenses: amount_minor, currency, exchange_rate, base_amount_minor,
--      base_currency, category, party_id, voucher_number, shift_id,
--      reversal_of_id محصّنة. ⚠️ payable_id مستثنى عمدًا: مساران قائمان
--      (تنظيف التزامات المختبر عند الإلغاء) يضبطانه NULL — رابطُ سير عملٍ
--      لا قيمة محاسبية.
--    - inventory_movements: item_id, kind, qty, unit_cost_minor, is_return,
--      visit_id, patient_id, expiry_date محصّنة — فمتوسط التكلفة الموزون
--      يُشتق من الحركات كاملةً، وتعديل حركة تاريخية يُفسد كل WAC اللاحق بصمت.
--
--  * DELETE guards (P1-FIX-3): BEFORE DELETE على الجداول الثلاثة — الأحداث
--    المالية والمخزنية التاريخية لا تُحذف بDELETE عادي أبدًا، لا من التطبيق
--    ولا من psql ولا بتتالٍ (patient cascade يمسّ هذه الجداول ⇒ الحارس يرفض).
--    التصحيح: reversal/refund (payments)، حدث إبطال معاكس expenses.reversal_of_id
--    (voidExpense)، حركة تسوية جديدة (inventory). أي حاجة مستقبلية لGDPR/legal
--    purge هي workflow منفصل مصرَّح ومدقَّق بتاريخه — ليست DELETE من النظام.
--
--  * patient_opening_balances مستثنى من الحارس عمدًا وموثَّق: هو حالة لا حدث —
--    صفٌّ واحد لكل مريض، ومسار التصحيح الرسمي في البرنامج (setPatientOpeningBalance)
--    ON CONFLICT DO UPDATE صراحةً لتجنب تضارب الدَّين عند الإدخال المزدوج.
--
--  * audit_log نفسه محصّن من التعديل والحذف بtriggers قائمة من قبل (db.ts baseline).
--
--  * حذف مريض له تاريخ مالي/مخزوني: يمنعه التطبيق مسبقًا برسالة صريحة
--    (deletePatientCascade: has_financial_history) — والحارس هنا شبكة الأمان
--    التي ترفض حتى المسار غير المتوقع.

CREATE OR REPLACE FUNCTION aqlan_payments_append_only_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_minor      IS DISTINCT FROM OLD.amount_minor
     OR NEW.currency       IS DISTINCT FROM OLD.currency
     OR NEW.exchange_rate  IS DISTINCT FROM OLD.exchange_rate
     OR NEW.base_amount_minor IS DISTINCT FROM OLD.base_amount_minor
     OR NEW.base_currency  IS DISTINCT FROM OLD.base_currency
     OR NEW.kind           IS DISTINCT FROM OLD.kind
     OR NEW.invoice_id     IS DISTINCT FROM OLD.invoice_id
     OR NEW.shift_id       IS DISTINCT FROM OLD.shift_id
     OR NEW.receipt_number IS DISTINCT FROM OLD.receipt_number
     OR NEW.patient_id     IS DISTINCT FROM OLD.patient_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.idempotency_request_hash IS DISTINCT FROM OLD.idempotency_request_hash
     OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id THEN
    RAISE EXCEPTION 'payments حدث مالي تاريخي غير قابل للتعديل (append-only): التصحيح يكون بردّ صريح، لا بUPDATE.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_append_only ON payments;
CREATE TRIGGER payments_append_only BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION aqlan_payments_append_only_guard();

CREATE OR REPLACE FUNCTION aqlan_expenses_append_only_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.amount_minor      IS DISTINCT FROM OLD.amount_minor
     OR NEW.currency       IS DISTINCT FROM OLD.currency
     OR NEW.exchange_rate  IS DISTINCT FROM OLD.exchange_rate
     OR NEW.base_amount_minor IS DISTINCT FROM OLD.base_amount_minor
     OR NEW.base_currency  IS DISTINCT FROM OLD.base_currency
     OR NEW.category       IS DISTINCT FROM OLD.category
     OR NEW.party_id       IS DISTINCT FROM OLD.party_id
     OR NEW.voucher_number IS DISTINCT FROM OLD.voucher_number
     OR NEW.shift_id       IS DISTINCT FROM OLD.shift_id
     OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id THEN
    RAISE EXCEPTION 'expenses حدث مالي تاريخي غير قابل للتعديل (append-only): التصحيح يكون بقيد إبطال معاكس صريح، لا بUPDATE.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS expenses_append_only ON expenses;
CREATE TRIGGER expenses_append_only BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION aqlan_expenses_append_only_guard();

CREATE OR REPLACE FUNCTION aqlan_inventory_movements_append_only_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.item_id        IS DISTINCT FROM OLD.item_id
     OR NEW.kind        IS DISTINCT FROM OLD.kind
     OR NEW.qty         IS DISTINCT FROM OLD.qty
     OR NEW.unit_cost_minor IS DISTINCT FROM OLD.unit_cost_minor
     OR NEW.is_return   IS DISTINCT FROM OLD.is_return
     OR NEW.visit_id    IS DISTINCT FROM OLD.visit_id
     OR NEW.patient_id  IS DISTINCT FROM OLD.patient_id
     OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date THEN
    RAISE EXCEPTION 'inventory_movements حركة مخزون تاريخية غير قابلة للتعديل: تعديلها يُفسد متوسط التكلفة الموزون اللاحق — التصحيح بحركة تسوية جديدة.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inventory_movements_append_only ON inventory_movements;
CREATE TRIGGER inventory_movements_append_only BEFORE UPDATE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION aqlan_inventory_movements_append_only_guard();

-- ── DELETE guards (P1-FIX-3) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION aqlan_financial_delete_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% حدث تاريخي (append-only): الحذف بDELETE ممنوع على مستوى القاعدة. التصحيح حدث صريح (ردّ/إبطال/تسوية)، وأي purge قانوني/GDPR مستقبلًا workflow منفصل مصرَّح ومدقَّق — لا DELETE عادي.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_no_delete ON payments;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION aqlan_financial_delete_guard();

DROP TRIGGER IF EXISTS expenses_no_delete ON expenses;
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION aqlan_financial_delete_guard();

DROP TRIGGER IF EXISTS inventory_movements_no_delete ON inventory_movements;
CREATE TRIGGER inventory_movements_no_delete BEFORE DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION aqlan_financial_delete_guard();

-- رابط إبطال المصروف بسنده الأصلي (P1-FIX-3): voidExpense يسجّل قيدًا معاكسًا
-- يشير للسند المُبطَل — الحذف لم يعد مسارًا، والإبطال له أثر قابل للتتبع.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS reversal_of_id INTEGER REFERENCES expenses(id) ON DELETE RESTRICT;
