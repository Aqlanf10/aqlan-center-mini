-- 0003 — Payment Idempotency & Single-Reversal Guard
-- حاجزا سباق ماليان يُثبتان بقيد قاعدة بيانات لا بفحص-ثم-إدراج في التطبيق:
--
-- 1) idempotency_key: مفتاح اختياري يرسله العميل (ترويسة Idempotency-Key).
--    طلبان متزامنان بالمفتاح نفسه → إدراجٌ واحد فقط ينجح (ON CONFLICT DO NOTHING
--    في recordPayment)، والثاني يعاد له السند الأول نفسه كـreplay. بلا المفتاح
--    يبقى السلوك كما كان. القيد فريد جزئي (NULL مسموح متكررًا).
--
-- 2) reversal_of_id: ربطٌ صريح لسند الردّ بالسند الذي يردّه، مع قيد فريد جزئي
--    على (reversal_of_id) لصفوف kind='refund': طلبا ردٍّ متزامنان للسند نفسه
--    → ردٌّ واحد فقط يُدرج والثاني يُرفض بقيد القاعدة. اليوم لا يوجد أي رابط
--    أو قيد يمنع ردّ سند واحد مرتين.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reversal_of_id INTEGER REFERENCES payments(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_uniq
  ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_single_reversal_uniq
  ON payments (reversal_of_id)
  WHERE reversal_of_id IS NOT NULL AND kind = 'refund';
