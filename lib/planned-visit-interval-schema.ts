/**
 * (SPEC-T4) فاصل الزيارة المخطَّطة — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0029_planned_visit_interval.sql`
 * حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * - `planned_visits.after_days`: كم يومًا بعد الزيارة السابقة تُقترح هذه الزيارة (من قالب التخصص:
 *   «تشكيل القنوات بعد ٧ أيام»، «مراجعة التقويم بعد ٢٨ يومًا»). فارغٌ = بلا فاصل مقرَّر.
 */
export const PLANNED_VISIT_INTERVAL_SQL = `ALTER TABLE planned_visits ADD COLUMN IF NOT EXISTS after_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planned_visits_after_days_range') THEN
    ALTER TABLE planned_visits ADD CONSTRAINT planned_visits_after_days_range
      CHECK (after_days IS NULL OR (after_days >= 0 AND after_days <= 365));
  END IF;
END $$;
`;
