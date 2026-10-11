-- PROPOSAL ONLY: no migration number, runtime registration, grants, or existing-table changes.
-- Exercised solely in a newly owned empty PostgreSQL fixture. Final names/FKs/authority
-- and backup registration require the parent's migration/ownership handoff.
CREATE TABLE hr_temporal_stream_proposal (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('employment','policy','schedule')),
  subject_key TEXT NOT NULL CHECK (length(btrim(subject_key)) BETWEEN 1 AND 100),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE(kind, subject_key)
);
CREATE TABLE hr_temporal_revision_proposal (
  stream_id BIGINT NOT NULL REFERENCES hr_temporal_stream_proposal(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  previous_revision INTEGER NOT NULL CHECK (previous_revision >= 0),
  actor_user_id BIGINT NOT NULL CHECK (actor_user_id > 0),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  PRIMARY KEY(stream_id,revision),
  CHECK (revision=previous_revision+1)
);
CREATE FUNCTION hr_temporal_validate_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_revision INTEGER; fact JSONB; start_day DATE; end_day DATE;
BEGIN
  SELECT revision INTO current_revision FROM hr_temporal_stream_proposal WHERE id=NEW.stream_id FOR UPDATE;
  IF current_revision IS NULL OR NEW.previous_revision<>current_revision OR NEW.revision<>current_revision+1 THEN
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
       OR length(btrim(fact->>'id')) NOT BETWEEN 1 AND 100 OR NOT fact ? 'value' THEN
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
  UPDATE hr_temporal_stream_proposal SET revision=NEW.revision WHERE id=NEW.stream_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hr_temporal_validate_proposal BEFORE INSERT ON hr_temporal_revision_proposal
  FOR EACH ROW EXECUTE FUNCTION hr_temporal_validate_proposal();
CREATE FUNCTION hr_temporal_immutable_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'temporal revisions are append-only'; END;
$$;
CREATE TRIGGER hr_temporal_immutable_proposal BEFORE UPDATE OR DELETE ON hr_temporal_revision_proposal
  FOR EACH ROW EXECUTE FUNCTION hr_temporal_immutable_proposal();
