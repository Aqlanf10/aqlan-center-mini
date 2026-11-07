-- Additive local candidate: durable command outcomes, not financial receipts.
-- Existing adjustments are unchanged and are not deduplicated by date/content.
CREATE TABLE ortho_adjustment_requests (
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL CHECK (request_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  adjustment_id INTEGER NOT NULL REFERENCES ortho_adjustments(id) ON DELETE RESTRICT,
  -- Preserve the referenced result; never erase request proof by deleting a visit.
  visit_id INTEGER REFERENCES visits(id) ON DELETE RESTRICT CHECK (visit_id IS NULL OR visit_id > 0),
  attached_to_today BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id, request_key)
);
CREATE INDEX ortho_adjustment_requests_case_idx ON ortho_adjustment_requests(case_id, adjustment_id);
CREATE FUNCTION check_ortho_adjustment_request() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF NOT EXISTS (SELECT 1 FROM ortho_adjustment_requests) THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'Orthodontic adjustment command outcomes are immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Orthodontic adjustment command outcomes are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id
    LEFT JOIN visits v ON v.id=a.visit_id
    WHERE a.id=NEW.adjustment_id AND a.case_id=NEW.case_id AND c.patient_id=NEW.patient_id
      AND a.visit_id IS NOT DISTINCT FROM NEW.visit_id
      AND (a.visit_id IS NULL OR v.patient_id=NEW.patient_id)
  ) OR (NEW.attached_to_today AND NEW.visit_id IS NULL) THEN
    RAISE EXCEPTION 'Orthodontic adjustment command scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER ortho_adjustment_request_integrity BEFORE INSERT OR UPDATE OR DELETE
  ON ortho_adjustment_requests FOR EACH ROW EXECUTE FUNCTION check_ortho_adjustment_request();
CREATE TRIGGER ortho_adjustment_request_no_truncate BEFORE TRUNCATE
  ON ortho_adjustment_requests FOR EACH STATEMENT EXECUTE FUNCTION check_ortho_adjustment_request();
