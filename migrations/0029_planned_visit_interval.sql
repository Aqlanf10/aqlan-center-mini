-- (SPEC-T4) Planned visit interval: days after the previous visit, from the specialty template.
-- Body must remain byte-for-byte equal to PLANNED_VISIT_INTERVAL_SQL after these comments.
ALTER TABLE planned_visits ADD COLUMN IF NOT EXISTS after_days INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planned_visits_after_days_range') THEN
    ALTER TABLE planned_visits ADD CONSTRAINT planned_visits_after_days_range
      CHECK (after_days IS NULL OR (after_days >= 0 AND after_days <= 365));
  END IF;
END $$;
