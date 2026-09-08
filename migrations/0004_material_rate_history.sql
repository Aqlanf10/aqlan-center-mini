-- 0004 — Material Rate History (Event-Time, Append-Only) — P1-FIX-6
-- نسب إهلاك المواد التي تُخصم من عمولة الطبيب كانت تُقرأ حيّةً من material_rates
-- في كل تقرير — فتعديل النسبة اليوم يُعيد كتابة كل تقارير العمولة التاريخية بصمت.
--
-- النموذج المحاسبي المعتمد (موثَّق في docs/DATABASE_MIGRATIONS.md):
--  * material_rates تبقى «النسبة الحالية» كما هي.
--  * كل تغيير نسبة يسجّل **صفًا جديدًا** في material_rate_history بسريان
--    effective_from = **TIMESTAMPTZ** للّحظة الكتابة (NOW()) — لا DATE يوميًّا:
--    سجل append-only حقيقي: لا UNIQUE(category, effective_from) ولا ON CONFLICT
--    DO UPDATE — تغييران في اليوم نفسه (أو الدقيقة نفسها) صفّان، والتقرير
--    يحلّ الأحدث وقت الحدث. كتابة النسبة الحالية + سطر التاريخ في **معاملة
--    واحدة** (setMaterialRate).
--  * تقرير العمولة يحلّ النسبة **لكل حدث تحصيل بمعيار طابعه الزمني** (وقت
--    الدفعة نفسها) — لا النسبة السارية في نهاية مدى التقرير لكامل الفترة:
--    حدث قبل تغيير النسبة يُحسب بالنسبة القديمة وحدث بعده بالجديدة، وتغيير
--    النسبة لاحقًا لا يغيّر أياً منهما.
--  * الصفوف الحالية تُبذَر بسريانٍ من لحظة تطبيق هذه الهجرة حصرًا — لا نختلق
--    تاريخًا قبل وجود التسجيل. ما قبل تاريخ التطبيق يظهر «غير مقيَّم» (unrated)
--    في التقارير القديمة كما لو كانت الميزة معطلة، وهو الأمانة المحاسبية: لا
--    ادّعاء رجعيًا بنسبةٍ لم تُسجَّل.
CREATE TABLE IF NOT EXISTS material_rate_history (
  id             SERIAL PRIMARY KEY,
  category       TEXT        NOT NULL,
  rate_bp        INTEGER     NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 10000),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by    TEXT,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- تنظيف دفاعي لقواعد جرّبت نماذج P1 الأولى (DATE + UNIQUE يومي + ON CONFLICT):
-- الإنتاج لم يعرفها أبدًا؛ الجمل التالية لا-عمل على قاعدة نظيفة.
ALTER TABLE material_rate_history DROP CONSTRAINT IF EXISTS material_rate_history_category_effective_from_key;
ALTER TABLE material_rate_history ALTER COLUMN effective_from TYPE TIMESTAMPTZ USING effective_from::timestamptz;
ALTER TABLE material_rate_history ALTER COLUMN effective_from SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS material_rate_history_lookup_idx
  ON material_rate_history (category, effective_from DESC);

-- بذر التاريخ من النسب الحالية القائمة فقط (بسريان لحظة التطبيق — لا رجعيًا).
INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
SELECT category, rate_bp, NOW(), 'migration-0004'
  FROM material_rates;
