/**
 * 0134 (docs/finance/SHARED_LAB_COST_ALLOCATION_0134.md; owner #483 6902952517, 6904933217): a participant of a
 * shared case may carry an optional `labCostBp`, the administrative allocation of the case's lab cost. Either no
 * participant carries it, or all do and they add up to 10,000. Rows written before 0134 carry none and keep
 * meaning "by work shares". The table stays append-only; no row is changed.
 *
 * Staged in `migrations/proposals/0134_commission_lab_cost_allocation.sql` pending DOT migration-number confirmation.
 */
export const COMMISSION_LAB_COST_ALLOCATION_SQL = String.raw`CREATE OR REPLACE FUNCTION aqlan_commission_participants_total_bp(participants JSONB) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE part JSONB; total BIGINT := 0; seen BIGINT[] := '{}'; doctor BIGINT; share BIGINT; keys INTEGER;
BEGIN
 IF participants IS NULL OR jsonb_typeof(participants) <> 'array' THEN RETURN -1; END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(participants) LOOP
  IF jsonb_typeof(part) <> 'object' OR NOT (part ?& ARRAY['doctorId','shareBp']) THEN RETURN -1; END IF;
  keys := (SELECT count(*) FROM jsonb_object_keys(part));
  IF NOT (keys = 2 OR (keys = 3 AND part ? 'labCostBp'))
     OR jsonb_typeof(part->'doctorId') <> 'number' OR jsonb_typeof(part->'shareBp') <> 'number'
     OR (part->>'doctorId') !~ '^[1-9][0-9]{0,9}$' OR (part->>'shareBp') !~ '^[1-9][0-9]{0,4}$' THEN RETURN -1; END IF;
  IF part ? 'labCostBp' AND (jsonb_typeof(part->'labCostBp') <> 'number' OR (part->>'labCostBp') !~ '^(0|[1-9][0-9]{0,4})$'
     OR (part->>'labCostBp')::bigint > 10000) THEN RETURN -1; END IF;
  doctor := (part->>'doctorId')::bigint; share := (part->>'shareBp')::bigint;
  IF share > 10000 OR doctor = ANY(seen) THEN RETURN -1; END IF;
  seen := array_append(seen, doctor); total := total + share;
 END LOOP;
 RETURN total::integer;
END;
$$;
CREATE OR REPLACE FUNCTION aqlan_commission_participants_lab_cost_ok(participants JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE part JSONB; carrying INTEGER := 0; members INTEGER := 0; total BIGINT := 0;
BEGIN
 IF participants IS NULL OR jsonb_typeof(participants) <> 'array' THEN RETURN FALSE; END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(participants) LOOP
  members := members + 1;
  IF jsonb_typeof(part) = 'object' AND part ? 'labCostBp' THEN
   IF jsonb_typeof(part->'labCostBp') <> 'number' OR (part->>'labCostBp') !~ '^(0|[1-9][0-9]{0,4})$' THEN RETURN FALSE; END IF;
   carrying := carrying + 1; total := total + (part->>'labCostBp')::bigint;
  END IF;
 END LOOP;
 RETURN carrying = 0 OR (carrying = members AND total = 10000);
END;
$$;
ALTER TABLE commission_case_participations DROP CONSTRAINT IF EXISTS commission_case_participations_lab_cost_check;
ALTER TABLE commission_case_participations ADD CONSTRAINT commission_case_participations_lab_cost_check
  CHECK (aqlan_commission_participants_lab_cost_ok(participants));`;
