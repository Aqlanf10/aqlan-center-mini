-- (ORTHO-ID-2) أصل تصحيح دراسة السيفالو: corrects_analysis_id. الرقم 0047 محجوز من dot (تعليق التنسيق على #314، 2026-10-09).
-- Additive only: one nullable column, two named constraints, one unique index (needed by the composite FK) and one partial index.
-- No backfill: corrections made before this column keep a NULL origin; none is guessed from the note text.
-- Body must remain byte-for-byte equal to CEPH_CORRECTION_LINEAGE_SQL after these comments.
ALTER TABLE ceph_analyses ADD COLUMN IF NOT EXISTS corrects_analysis_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS ceph_analyses_patient_id_key ON ceph_analyses (patient_id, id);
DO $ceph_lineage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ceph_analyses'::regclass AND conname = 'ceph_analyses_corrects_older_chk') THEN
    ALTER TABLE ceph_analyses ADD CONSTRAINT ceph_analyses_corrects_older_chk
      CHECK (corrects_analysis_id IS NULL OR corrects_analysis_id < id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ceph_analyses'::regclass AND conname = 'ceph_analyses_corrects_same_patient_fk') THEN
    ALTER TABLE ceph_analyses ADD CONSTRAINT ceph_analyses_corrects_same_patient_fk
      FOREIGN KEY (patient_id, corrects_analysis_id) REFERENCES ceph_analyses (patient_id, id);
  END IF;
END
$ceph_lineage$;
CREATE INDEX IF NOT EXISTS ceph_analyses_corrects_idx ON ceph_analyses (corrects_analysis_id) WHERE corrects_analysis_id IS NOT NULL;
