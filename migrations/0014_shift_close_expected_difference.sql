-- 0014 — Shift Close: Expected, Difference, Reason — P1-3
--
-- العيب الذي تعالجه: إغلاق الوردية كان يحفظ المعدود وحده — لا المتوقَّع ولا الفرق —
-- والشاشة تملأ حقل «المعدود» بالمتوقَّع سلفًا، وتكتب «مقفل ومطابق» لكل وردية مقفلة
-- مهما كان الجرد. فعجزُ الدرج لا يظهر في أي مكان.
--
-- النموذج:
--  * expected_*: ما يجب أن يكون في الدرج لحظة الإقفال لكل عملة — الافتتاحي + المقبوض
--    نقدًا − المردود نقدًا − سندات الصرف (lib/shift-close.ts). التحويل لا يدخل الدرج.
--  * difference_*: المعدود − المتوقَّع (سالب = عجز). وفرقٌ غير صفري لا يُقفَل بلا سبب
--    (difference_reason) — قيدٌ بنيوي NOT VALID: يُفرض على كل إقفالٍ جديد ولا يُفشل
--    الهجرة بصفٍّ قديم.
--  * الوردية المقفلة append-only: لا UPDATE بعد الإقفال (حارس بنيوي) — التصحيح قيدٌ
--    في الوردية المفتوحة، كما في سندات الصرف والقبض.
--
-- لا بذر: الورديات المقفلة قبل هذه الهجرة يُحسب متوقَّعها عند القراءة بالقاعدة نفسها
-- (بلا كتابة على سجلٍّ تاريخي)، وتُعرض موسومةً «محسوب».
ALTER TABLE cashier_shifts ADD COLUMN IF NOT EXISTS expected_yer      BIGINT;
ALTER TABLE cashier_shifts ADD COLUMN IF NOT EXISTS expected_sar      BIGINT;
ALTER TABLE cashier_shifts ADD COLUMN IF NOT EXISTS expected_usd      BIGINT;
ALTER TABLE cashier_shifts ADD COLUMN IF NOT EXISTS difference_yer    BIGINT;
ALTER TABLE cashier_shifts ADD COLUMN IF NOT EXISTS difference_sar    BIGINT;
ALTER TABLE cashier_shifts ADD COLUMN IF NOT EXISTS difference_usd    BIGINT;
ALTER TABLE cashier_shifts ADD COLUMN IF NOT EXISTS difference_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashier_shifts_difference_needs_reason') THEN
    ALTER TABLE cashier_shifts ADD CONSTRAINT cashier_shifts_difference_needs_reason
      CHECK (
        (COALESCE(difference_yer, 0) = 0 AND COALESCE(difference_sar, 0) = 0 AND COALESCE(difference_usd, 0) = 0)
        OR (difference_reason IS NOT NULL AND btrim(difference_reason) <> '')
      ) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION aqlan_closed_shift_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'cashier_shifts وردية مقفلة ومجرودة (append-only): لا يُعدَّل جردها ولا متوقَّعها ولا فرقها بعد الإقفال — التصحيح قيدٌ في الوردية المفتوحة.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cashier_shifts_closed_guard ON cashier_shifts;
CREATE TRIGGER cashier_shifts_closed_guard BEFORE UPDATE ON cashier_shifts
  FOR EACH ROW EXECUTE FUNCTION aqlan_closed_shift_guard();
