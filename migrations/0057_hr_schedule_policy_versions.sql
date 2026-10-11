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
    -- With day offsets 0/1 only consecutive weekday anchors can overlap.
    -- Check actual segment intervals, including Saturday→Sunday, not split-shift envelopes.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(payload->'workingDays') d
        CROSS JOIN jsonb_array_elements(payload->'segments') a
        CROSS JOIN jsonb_array_elements(payload->'segments') b
      WHERE payload->'workingDays' @> to_jsonb(ARRAY[(d::int+1)%7])
        AND extract(epoch FROM (a->>'start')::time) + (a->>'startDayOffset')::int * 86400
          < extract(epoch FROM (b->>'end')::time) + ((b->>'endDayOffset')::int+1) * 86400
        AND extract(epoch FROM (b->>'start')::time) + ((b->>'startDayOffset')::int+1) * 86400
          < extract(epoch FROM (a->>'end')::time) + (a->>'endDayOffset')::int * 86400
    ) THEN RAISE EXCEPTION 'occurrence_overlap' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'invalid_domain' USING ERRCODE='23514'; END IF;
END;
$$;

-- AT TIME ZONE alone silently chooses a DST fold/gap. Require a unique round trip,
-- mirroring the source materializer. This is resolution evidence, not worked time.
CREATE FUNCTION aqlan_hr_unique_wall_instant(day DATE, clock TEXT, zone TEXT)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql AS $$
DECLARE wall TIMESTAMP; nominal TIMESTAMPTZ; matches INTEGER; resolved TIMESTAMPTZ;
BEGIN
  IF day<DATE '0001-01-01' OR day>DATE '9999-12-31' THEN
    RAISE EXCEPTION 'invalid_date' USING ERRCODE='23514';
  END IF;
  wall:=day+clock::time; nominal:=wall AT TIME ZONE 'UTC';
  WITH offsets AS (
    SELECT DISTINCT ((nominal+h*interval '1 hour') AT TIME ZONE zone)
      - ((nominal+h*interval '1 hour') AT TIME ZONE 'UTC') AS delta
    FROM unnest(ARRAY[-36,-24,-12,0,12,24,36]) h
  ), candidates AS (
    SELECT DISTINCT nominal-delta AS value FROM offsets
    WHERE (nominal-delta) AT TIME ZONE zone=wall
  ) SELECT count(*),min(value) INTO matches,resolved FROM candidates;
  IF matches=0 THEN RAISE EXCEPTION 'nonexistent_wall_time' USING ERRCODE='23514'; END IF;
  IF matches<>1 THEN RAISE EXCEPTION 'ambiguous_wall_time' USING ERRCODE='23514'; END IF;
  IF abs(extract(epoch FROM nominal-resolved))>=86400 THEN
    RAISE EXCEPTION 'timezone_offset_unresolved' USING ERRCODE='23514';
  END IF;
  RETURN resolved;
END;
$$;
CREATE FUNCTION aqlan_hr_schedule_windows(payload JSONB, anchor_day DATE)
RETURNS TABLE(bounds TSTZRANGE) LANGUAGE plpgsql AS $$
DECLARE segment JSONB; starts TIMESTAMPTZ; ends TIMESTAMPTZ;
BEGIN
  IF NOT payload->'workingDays' @> to_jsonb(ARRAY[extract(dow FROM anchor_day)::int]) THEN RETURN; END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(payload->'segments') LOOP
    starts:=aqlan_hr_unique_wall_instant(anchor_day+(segment->>'startDayOffset')::int,segment->>'start',payload->>'timeZone');
    ends:=aqlan_hr_unique_wall_instant(anchor_day+(segment->>'endDayOffset')::int,segment->>'end',payload->>'timeZone');
    IF ends<=starts THEN RAISE EXCEPTION 'segment_overlap' USING ERRCODE='23514'; END IF;
    bounds:=tstzrange(starts,ends,'[)'); RETURN NEXT;
  END LOOP;
END;
$$;
CREATE FUNCTION aqlan_hr_validate_schedule_occurrences() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE domain TEXT; pair RECORD; left_day DATE; right_day DATE; left_offset INTEGER; right_offset INTEGER;
BEGIN
  SELECT kind INTO STRICT domain FROM hr_effective_streams WHERE id=NEW.stream_id;
  IF domain<>'schedule' THEN RETURN NEW; END IF;
  -- The generic revision validator runs first alphabetically and holds the stream lock.
  -- Each endpoint is in local [anchor,anchor+2 days), with an offset strictly within
  -- ±24h. Anchors >=4 days apart cannot overlap, including a change of time zone.
  FOR pair IN
    SELECT a.f AS left_fact,b.f AS right_fact
    FROM jsonb_array_elements(NEW.snapshot->'facts') a(f)
      CROSS JOIN jsonb_array_elements(NEW.snapshot->'facts') b(f)
    WHERE a.f->>'kind'='known' AND b.f->>'kind'='known'
      AND (a.f->>'from')::date<(b.f->>'from')::date
      AND (b.f->>'from')::date-(a.f->>'to')::date BETWEEN 0 AND 2
  LOOP
    FOR left_offset IN 1..3 LOOP
      left_day:=(pair.left_fact->>'to')::date-left_offset;
      IF left_day<(pair.left_fact->>'from')::date THEN CONTINUE; END IF;
      FOR right_offset IN 0..2 LOOP
        right_day:=(pair.right_fact->>'from')::date+right_offset;
        IF right_day>DATE '9999-12-31' OR right_day>=(pair.right_fact->>'to')::date THEN CONTINUE; END IF;
        IF EXISTS (
          SELECT 1 FROM aqlan_hr_schedule_windows(pair.left_fact->'value',left_day) a
            CROSS JOIN aqlan_hr_schedule_windows(pair.right_fact->'value',right_day) b
          WHERE a.bounds && b.bounds
        ) THEN RAISE EXCEPTION 'occurrence_overlap' USING ERRCODE='23514'; END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hr_effective_schedule_occurrences_validate BEFORE INSERT ON hr_effective_revisions
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_validate_schedule_occurrences();
