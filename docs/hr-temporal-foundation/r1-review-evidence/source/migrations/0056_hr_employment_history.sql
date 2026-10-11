-- RESERVED by parent: dot review 2026-10-11 20:55 UTC.
-- Source review / isolated tests only. Not registered in the shared migration runner.
-- No backfill: current work_status/updated_at do not establish effective history.
CREATE TABLE hr_effective_streams (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  staff_id INTEGER REFERENCES hr_staff(id) ON DELETE RESTRICT,
  CONSTRAINT hr_effective_stream_scope CHECK (
    kind='employment' AND staff_id IS NOT NULL AND subject_key=staff_id::text
  ),
  UNIQUE(kind, subject_key)
);
CREATE TABLE hr_effective_revisions (
  stream_id BIGINT NOT NULL REFERENCES hr_effective_streams(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  previous_revision INTEGER NOT NULL CHECK (previous_revision >= 0),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  PRIMARY KEY(stream_id,revision),
  CHECK (revision=previous_revision+1)
);
CREATE FUNCTION aqlan_hr_validate_effective_value(domain TEXT, subject TEXT, payload JSONB, fact_kind TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF domain<>'employment' OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
     OR payload->>'status' IS NULL OR payload->>'status' NOT IN ('active','suspended','ended') THEN
    RAISE EXCEPTION 'invalid_employment' USING ERRCODE='23514';
  END IF;
END;
$$;
CREATE FUNCTION aqlan_hr_validate_effective_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_revision INTEGER; stream hr_effective_streams%ROWTYPE;
  fact JSONB; start_day DATE; end_day DATE; previous_snapshot JSONB;
BEGIN
  -- Serialize writers for one employee/policy; the head is derived from immutable rows.
  SELECT * INTO STRICT stream FROM hr_effective_streams WHERE id=NEW.stream_id FOR UPDATE;
  SELECT COALESCE(MAX(revision),0) INTO current_revision FROM hr_effective_revisions WHERE stream_id=NEW.stream_id;
  IF NEW.previous_revision<>current_revision OR NEW.revision<>current_revision+1 THEN
    RAISE EXCEPTION 'stale_revision' USING ERRCODE='40001';
  END IF;
  IF jsonb_typeof(NEW.snapshot->'revision') IS DISTINCT FROM 'number'
     OR (NEW.snapshot->>'revision')::numeric<>NEW.revision
     OR jsonb_typeof(NEW.snapshot->'facts') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_timeline' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(NEW.snapshot->'facts')>1000 THEN RAISE EXCEPTION 'invalid_timeline' USING ERRCODE='23514'; END IF;
  FOR fact IN SELECT value FROM jsonb_array_elements(NEW.snapshot->'facts') LOOP
    IF jsonb_typeof(fact) IS DISTINCT FROM 'object' OR jsonb_typeof(fact->'id') IS DISTINCT FROM 'string'
       OR length(fact->>'id') NOT BETWEEN 1 AND 100 OR length(btrim(fact->>'id'))=0 OR NOT fact ? 'value' THEN
      RAISE EXCEPTION 'invalid_fact' USING ERRCODE='23514';
    END IF;
    IF fact->>'kind'='known' THEN
      IF jsonb_typeof(fact->'from') IS DISTINCT FROM 'string' OR (fact->>'from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         OR NOT fact ? 'to' OR (fact->'to'<>'null'::jsonb AND (jsonb_typeof(fact->'to') IS DISTINCT FROM 'string' OR (fact->>'to') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')) THEN
        RAISE EXCEPTION 'invalid_range' USING ERRCODE='23514';
      END IF;
      start_day := (fact->>'from')::date; end_day := (fact->>'to')::date;
      IF end_day IS NOT NULL AND end_day<=start_day THEN RAISE EXCEPTION 'invalid_range' USING ERRCODE='23514'; END IF;
    ELSIF fact->>'kind'='unknown' THEN
      IF fact ? 'from' OR fact ? 'to' THEN RAISE EXCEPTION 'unknown_dates_forbidden' USING ERRCODE='23514'; END IF;
    ELSE RAISE EXCEPTION 'invalid_fact_kind' USING ERRCODE='23514'; END IF;
    PERFORM aqlan_hr_validate_effective_value(stream.kind,stream.subject_key,fact->'value',fact->>'kind');
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'facts') f GROUP BY f->>'id' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'duplicate_fact' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'facts') WITH ORDINALITY a(f,n)
      JOIN jsonb_array_elements(NEW.snapshot->'facts') WITH ORDINALITY b(f,n) ON a.n<b.n
    WHERE a.f->>'kind'='known' AND b.f->>'kind'='known'
      AND daterange((a.f->>'from')::date,(a.f->>'to')::date,'[)') && daterange((b.f->>'from')::date,(b.f->>'to')::date,'[)')
  ) THEN RAISE EXCEPTION 'overlap' USING ERRCODE='23514'; END IF;
  SELECT snapshot INTO previous_snapshot FROM hr_effective_revisions WHERE stream_id=NEW.stream_id AND revision=current_revision;
  -- IDs identify immutable facts. A correction replaces them; a retired ID cannot be recycled.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.snapshot->'facts') n
      JOIN hr_effective_revisions r ON r.stream_id=NEW.stream_id
      CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'facts') prior_fact
    WHERE prior_fact->>'id'=n->>'id' AND (prior_fact<>n OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(previous_snapshot->'facts') p WHERE p->>'id'=n->>'id'
    ))
  ) THEN RAISE EXCEPTION 'fact_id_reused' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hr_effective_revision_validate BEFORE INSERT ON hr_effective_revisions
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_validate_effective_revision();
CREATE FUNCTION aqlan_hr_effective_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'effective history is append-only' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER hr_effective_revision_immutable BEFORE UPDATE OR DELETE ON hr_effective_revisions
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_effective_append_only();
CREATE TRIGGER hr_effective_stream_immutable BEFORE UPDATE OR DELETE ON hr_effective_streams
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_effective_append_only();
CREATE TRIGGER hr_effective_revision_no_truncate BEFORE TRUNCATE ON hr_effective_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_hr_effective_append_only();
CREATE TRIGGER hr_effective_stream_no_truncate BEFORE TRUNCATE ON hr_effective_streams
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_hr_effective_append_only();
