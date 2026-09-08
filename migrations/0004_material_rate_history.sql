-- 0004 — Material Rate History (Effective-Dated Rates)
-- نسب إهلاك المواد التي تُخصم من عمولة الطبيب كانت تُقرأ حيّةً من material_rates
-- في كل تقرير — فتعديل النسبة اليوم يُعيد كتابة كل تقارير العمولة التاريخية بصمت.
--
-- النموذج المحاسبي المعتمد (موثَّق في docs/DATABASE_MIGRATIONS.md):
--  * material_rates تبقى «النسبة الحالية» كما هي.
--  * كل تعديل نسبة يسجّل صفًا في material_rate_history بتاريخ سريان effective_from
--    (اليوم الذي عُدِّل فيه) — سجل append-only للنسب.
--  * تقرير العمولة للمدى [from, to] يحلّ النسبة السارية في نهاية المدى (to)
--    من جدول التاريخ — فتعديلٌ اليوم لا يغيّر تقارير الماضي.
--  * الصفوف الحالية تُبذَر بسريانٍ من تاريخ تطبيق هذا المigration حصرًا — لا
--    نختلق تاريخًا قبل وجود التسجيل. ما قبل تاريخ التطبيق يظهر «غير مقيَّم»
--    (unrated) في التقارير القديمة كما لو كانت الميزة معطلة، وهو الأمانة
--    المحاسبية: لا ن ادّعاء رجعيًا بنسبةٍ لم تُسجَّل.
CREATE TABLE IF NOT EXISTS material_rate_history (
  id             SERIAL PRIMARY KEY,
  category       TEXT        NOT NULL,
  rate_bp        INTEGER     NOT NULL CHECK (rate_bp >= 0 AND rate_bp <= 10000),
  effective_from DATE        NOT NULL DEFAULT CURRENT_DATE,
  recorded_by    TEXT,
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category, effective_from)
);

CREATE INDEX IF NOT EXISTS material_rate_history_lookup_idx
  ON material_rate_history (category, effective_from DESC);

-- بذر التاريخ من النسب الحالية القائمة فقط (بسريان اليوم — لا رجعيًا).
INSERT INTO material_rate_history (category, rate_bp, effective_from, recorded_by)
SELECT category, rate_bp, CURRENT_DATE, 'migration-0004'
  FROM material_rates
ON CONFLICT (category, effective_from) DO NOTHING;
