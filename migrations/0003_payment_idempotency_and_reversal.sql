-- 0003 — Payment Idempotency (Request-Bound) & Refund Link (P1-FIX-4 / P1-FIX-5)
--
-- 1) idempotency_key + idempotency_request_hash: المفتاح الذي يرسله العميل
--    (ترويسة Idempotency-Key) وحده ليس هو العملية — المفتاح **مرتبط ببصمة
--    الطلب الكانونية** (actor/patient/invoice/kind/amount/currency/base/FX/
--    method/reversalOf — SHA-256 في recordPayment). طلبان متزامنان بالمفتاح
--    نفسه والبصمة نفسها ⇒ إدراج واحد والثاني replay للسند الأول. المفتاح نفسه
--    ببصمة مختلفة ⇒ idempotency_conflict (HTTP 409) — لا يُعاد سند عملية
--    مختلفة أبدًا. القيد الفريد الجزئي على المفتاح هو حارس السباق البنيوي
--    (ON CONFLICT DO NOTHING في recordPayment ينتظر التزام المعاملة المنافسة).
--
-- 2) reversal_of_id: رابط سند الردّ بالسند الذي يردّه (ON DELETE RESTRICT —
--    حذف سند له ردود مستحيل بنيويًّا). النموذج المعتمد (P1-FIX-5): **Partial
--    Refunds** — عدة ردود جزئية للسند نفسه مسموحة بشروط:
--      * الأصل kind='payment' لنفس المريض، وبعملة الأصل نفسها (ردّ بعملة
--        مختلفة مرفوض)، وبسعر صرف الأصل snapshot نفسه.
--      * amount > 0 ومجموع الردود <= مبلغ الأصل — الحارس حساب دوراني داخل
--        معاملة واحدة مع SELECT ... FOR UPDATE على صف الأصل (قفل صفّي يسلسل
--        الردود المتزامنة فلا يتجاوز مجموعها الأصل) في recordPayment.
--    لذلك **لا** يوجد UNIQUE(reversal_of_id): القيد الفريد الجزئي القديم
--    (ردّ واحد فقط) أُزيل عمدًا — نموذج الرد الكامل الواحد لم يعد النموذج.
--    (السطر DROP INDEX أدناه تنظيف دفاعي لقواعد جرّبت نماذج P1 الأولى؛
--    الإنتاج لم يعرف هذا القيد أبدًا.)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_request_hash TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reversal_of_id INTEGER REFERENCES payments(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_uniq
  ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS payments_single_reversal_uniq;
