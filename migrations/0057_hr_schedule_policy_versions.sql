-- RESERVED by parent: dot review 2026-10-11 20:55 UTC. Depends on exact reviewed 0056.
-- Source review / isolated tests only; no shared runner/db.ts registration or legacy writes.
ALTER TABLE hr_effective_streams DROP CONSTRAINT hr_effective_stream_scope;
ALTER TABLE hr_effective_streams ADD CONSTRAINT hr_effective_stream_scope CHECK (
  (kind IN ('employment','schedule') AND staff_id IS NOT NULL AND subject_key=staff_id::text)
  OR (kind='policy' AND staff_id IS NULL AND subject_key IN ('employment_pay_effect','proration','leave_entitlement'))
);
CREATE OR REPLACE FUNCTION aqlan_hr_validate_effective_value(domain TEXT, subject TEXT, payload JSONB, fact_kind TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE segment JSONB; segment_index INTEGER:=0; starts INTEGER; ends INTEGER; previous_end INTEGER:=-1;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid_value' USING ERRCODE='23514'; END IF;
  IF domain='employment' THEN
    IF payload->>'status' IS NULL OR payload->>'status' NOT IN ('active','suspended','ended') THEN
      RAISE EXCEPTION 'invalid_employment' USING ERRCODE='23514';
    END IF;
  ELSIF domain='policy' THEN
    IF payload->>'key' IS DISTINCT FROM subject OR jsonb_typeof(payload->'parameters') IS DISTINCT FROM 'object'
       OR jsonb_typeof(payload->'approval') IS DISTINCT FROM 'object'
       OR payload->'approval'->>'state' IS NULL OR payload->'approval'->>'state' NOT IN ('unapproved','approved') THEN
      RAISE EXCEPTION 'invalid_policy' USING ERRCODE='23514';
    END IF;
    IF payload->'approval'->>'state'='approved' AND (
      jsonb_typeof(payload->'approval'->'decisionRef') IS DISTINCT FROM 'string'
      OR length(btrim(payload->'approval'->>'decisionRef')) NOT BETWEEN 1 AND 1000
    ) THEN RAISE EXCEPTION 'approval_reference_required' USING ERRCODE='23514'; END IF;
    -- A recorded decision reference is evidence, not a grant of authority or an executable formula.
  ELSIF domain='schedule' THEN
    -- An unknown legacy observation can retain its source label without invented segments.
    IF fact_kind='unknown' THEN RETURN; END IF;
    IF jsonb_typeof(payload->'timeZone') IS DISTINCT FROM 'string'
       OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=payload->>'timeZone')
       OR jsonb_typeof(payload->'workingDays') IS DISTINCT FROM 'array'
       OR jsonb_typeof(payload->'segments') IS DISTINCT FROM 'array'
       OR jsonb_typeof(payload->'graceMins') IS DISTINCT FROM 'number'
       OR (payload->>'graceMins')::numeric NOT BETWEEN 0 AND 120
       OR trunc((payload->>'graceMins')::numeric)<>(payload->>'graceMins')::numeric THEN
      RAISE EXCEPTION 'invalid_schedule' USING ERRCODE='23514';
    END IF;
    IF jsonb_array_length(payload->'workingDays') NOT BETWEEN 1 AND 7
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'workingDays') d WHERE d NOT IN ('0','1','2','3','4','5','6'))
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'workingDays') d GROUP BY d HAVING count(*)>1)
       OR jsonb_array_length(payload->'segments') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'invalid_schedule' USING ERRCODE='23514';
    END IF;
    FOR segment IN SELECT value FROM jsonb_array_elements(payload->'segments') LOOP
      IF jsonb_typeof(segment) IS DISTINCT FROM 'object' OR jsonb_typeof(segment->'id') IS DISTINCT FROM 'string'
         OR length(segment->>'id') NOT BETWEEN 1 AND 100 OR length(btrim(segment->>'id'))=0
         OR jsonb_typeof(segment->'start') IS DISTINCT FROM 'string' OR segment->>'start' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         OR jsonb_typeof(segment->'end') IS DISTINCT FROM 'string' OR segment->>'end' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         OR segment->'startDayOffset' IS NULL OR segment->'startDayOffset' NOT IN ('0','1')
         OR segment->'endDayOffset' IS NULL OR segment->'endDayOffset' NOT IN ('0','1') THEN
        RAISE EXCEPTION 'invalid_segments' USING ERRCODE='23514';
      END IF;
      starts:=(split_part(segment->>'start',':',1)::int*60)+split_part(segment->>'start',':',2)::int+(segment->>'startDayOffset')::int*1440;
      ends:=(split_part(segment->>'end',':',1)::int*60)+split_part(segment->>'end',':',2)::int+(segment->>'endDayOffset')::int*1440;
      IF ends<=starts OR starts<previous_end OR (segment_index=0 AND segment->>'startDayOffset'<>'0') THEN
        RAISE EXCEPTION 'segment_overlap' USING ERRCODE='23514';
      END IF;
      previous_end:=ends; segment_index:=segment_index+1;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'segments') s GROUP BY s->>'id' HAVING count(*)>1) THEN
      RAISE EXCEPTION 'duplicate_segment' USING ERRCODE='23514';
    END IF;
  ELSE RAISE EXCEPTION 'invalid_domain' USING ERRCODE='23514'; END IF;
END;
$$;
