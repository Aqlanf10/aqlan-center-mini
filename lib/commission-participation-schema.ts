/**
 * Doctors sharing a case (owner decision 2026-11-11, finance point 3, option 2, decided per case).
 * One append-only record per decision: the participants and their shares of the work (basis points
 * that add up to 10,000 when approved), who decided, when, from what source and why. A later
 * decision supersedes the head of the case's chain; nothing is updated or deleted. `pending` marks
 * a shared case whose split is not approved yet: its commission is held. `void` ends the sharing.
 *
 * Additive only. `migrations/0126_commission_case_participations.sql` must remain byte-for-byte
 * equal to this SQL (as 0089 does): the runtime registration and the file share one checksum.
 */
export const COMMISSION_CASE_PARTICIPATIONS_SQL = String.raw`CREATE OR REPLACE FUNCTION aqlan_commission_participants_total_bp(participants JSONB) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE part JSONB; total BIGINT := 0; seen BIGINT[] := '{}'; doctor BIGINT; share BIGINT;
BEGIN
 IF participants IS NULL OR jsonb_typeof(participants) <> 'array' THEN RETURN -1; END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(participants) LOOP
  IF jsonb_typeof(part) <> 'object' OR NOT (part ?& ARRAY['doctorId','shareBp'])
     OR (SELECT count(*) FROM jsonb_object_keys(part)) <> 2
     OR jsonb_typeof(part->'doctorId') <> 'number' OR jsonb_typeof(part->'shareBp') <> 'number'
     OR (part->>'doctorId') !~ '^[1-9][0-9]{0,9}$' OR (part->>'shareBp') !~ '^[1-9][0-9]{0,4}$' THEN RETURN -1; END IF;
  doctor := (part->>'doctorId')::bigint; share := (part->>'shareBp')::bigint;
  IF share > 10000 OR doctor = ANY(seen) THEN RETURN -1; END IF;
  seen := array_append(seen, doctor); total := total + share;
 END LOOP;
 RETURN total::integer;
END;
$$;
CREATE TABLE IF NOT EXISTS commission_case_participations (
  id                 BIGSERIAL    PRIMARY KEY,
  case_id            INTEGER      NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  status             TEXT         NOT NULL CHECK (status IN ('approved', 'pending', 'void')),
  participants       JSONB        NOT NULL DEFAULT '[]'::jsonb,
  source             TEXT         NOT NULL CHECK (source IN ('centre_decision', 'sessions_guided', 'equal')),
  reason             TEXT         NOT NULL CHECK (length(btrim(reason)) > 0),
  supersedes_id      BIGINT       REFERENCES commission_case_participations(id) ON DELETE RESTRICT,
  decided_by         TEXT         NOT NULL CHECK (length(btrim(decided_by)) > 0),
  decided_by_user_id INTEGER      REFERENCES users(id) ON DELETE RESTRICT,
  decided_at         TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT commission_case_participations_shares_check
    CHECK (CASE status WHEN 'approved' THEN aqlan_commission_participants_total_bp(participants) = 10000
                       ELSE participants = '[]'::jsonb END),
  CONSTRAINT commission_case_participations_void_check CHECK (status <> 'void' OR supersedes_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS commission_case_participations_supersedes_uniq
  ON commission_case_participations (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commission_case_participations_root_uniq
  ON commission_case_participations (case_id) WHERE supersedes_id IS NULL;
CREATE INDEX IF NOT EXISTS commission_case_participations_case_idx
  ON commission_case_participations (case_id, decided_at);
CREATE OR REPLACE FUNCTION aqlan_commission_case_participations_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'قرار مشاركة الأطباء في الحالة لا يُعدَّل ولا يُحذف — يُستبدل بقرار جديد مسبَّب.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS commission_case_participations_append_only ON commission_case_participations;
CREATE TRIGGER commission_case_participations_append_only BEFORE UPDATE OR DELETE ON commission_case_participations
  FOR EACH ROW EXECUTE FUNCTION aqlan_commission_case_participations_append_only();`;
