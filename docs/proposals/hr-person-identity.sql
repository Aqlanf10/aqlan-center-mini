-- PROPOSAL ONLY: unnumbered, unregistered, no startup execution or data backfill.
-- Base: main fe3b66740882b83aeeeee969de6bace7ed50a492. Number reserved by parent.
-- Test fixtures apply this SQL explicitly inside their isolated PostgreSQL DB.
ALTER TABLE hr_staff ADD COLUMN identity_revision INTEGER NOT NULL DEFAULT 0 CHECK (identity_revision >= 0);
ALTER TABLE hr_staff DROP CONSTRAINT hr_staff_work_status_check;
ALTER TABLE hr_staff ADD CONSTRAINT hr_staff_work_status_check CHECK (work_status IN ('unconfirmed','active','suspended','ended'));
ALTER TABLE hr_staff ALTER COLUMN work_status SET DEFAULT 'unconfirmed';
ALTER TABLE hr_staff DROP CONSTRAINT hr_staff_contract_kind_check;
ALTER TABLE hr_staff ADD CONSTRAINT hr_staff_contract_kind_check CHECK (contract_kind IN ('unspecified','commission','salary','salary_commission'));
ALTER TABLE hr_staff ALTER COLUMN contract_kind SET DEFAULT 'unspecified';
ALTER TABLE hr_staff DROP CONSTRAINT hr_staff_pay_terms_complete;
ALTER TABLE hr_staff ADD CONSTRAINT hr_staff_pay_terms_complete CHECK (
  contract_kind = 'commission' OR
  (contract_kind = 'unspecified' AND salary_amount_minor IS NULL AND salary_currency IS NULL
    AND salary_period IS NULL AND salary_effective_on IS NULL) OR
  (contract_kind IN ('salary','salary_commission') AND salary_amount_minor IS NOT NULL
    AND salary_currency IS NOT NULL AND salary_period IS NOT NULL AND salary_effective_on IS NOT NULL)
);

CREATE TABLE hr_identity_import_runs (
  id UUID PRIMARY KEY,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('apply','correct')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 100),
  plan_digest TEXT NOT NULL UNIQUE CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  response JSONB NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_user_id,operation,request_id)
);
CREATE TABLE hr_identity_events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES hr_identity_import_runs(id) DEFERRABLE INITIALLY DEFERRED,
  staff_id INTEGER NOT NULL REFERENCES hr_staff(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('create','confirm','link_account','close_account','link_party','close_party')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  source_ref TEXT NOT NULL CHECK (length(btrim(source_ref)) BETWEEN 3 AND 200),
  details JSONB NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX hr_identity_events_staff_idx ON hr_identity_events(staff_id,revision,id);
CREATE TABLE hr_staff_account_links (
  id BIGSERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES hr_staff(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_event_id BIGINT NOT NULL REFERENCES hr_identity_events(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_event_id BIGINT REFERENCES hr_identity_events(id),
  closed_at TIMESTAMPTZ,
  CHECK ((closed_at IS NULL) = (closed_event_id IS NULL)),
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
CREATE UNIQUE INDEX hr_staff_account_links_current_user ON hr_staff_account_links(user_id) WHERE closed_at IS NULL;
CREATE INDEX hr_staff_account_links_staff_history ON hr_staff_account_links(staff_id,user_id,id);
CREATE TABLE hr_staff_party_links (
  id BIGSERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES hr_staff(id) ON DELETE RESTRICT,
  party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  opened_event_id BIGINT NOT NULL REFERENCES hr_identity_events(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_event_id BIGINT REFERENCES hr_identity_events(id),
  closed_at TIMESTAMPTZ,
  CHECK ((closed_at IS NULL) = (closed_event_id IS NULL)),
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
CREATE UNIQUE INDEX hr_staff_party_links_current_staff ON hr_staff_party_links(staff_id) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX hr_staff_party_links_current_party ON hr_staff_party_links(party_id) WHERE closed_at IS NULL;

-- Old requests remain NULL: no reconstruction of a historical actor from a name.
ALTER TABLE hr_leave_requests ADD COLUMN requester_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN identity_evidence JSONB CHECK (identity_evidence IS NULL OR jsonb_typeof(identity_evidence) = 'object');
ALTER TABLE hr_attendance_corrections ADD COLUMN requester_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN identity_evidence JSONB CHECK (identity_evidence IS NULL OR jsonb_typeof(identity_evidence) = 'object');

CREATE FUNCTION aqlan_hr_identity_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'hr identity evidence is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_identity_runs_append_only BEFORE UPDATE OR DELETE ON hr_identity_import_runs
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_identity_append_only();
CREATE TRIGGER hr_identity_events_append_only BEFORE UPDATE OR DELETE ON hr_identity_events
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_identity_append_only();

CREATE FUNCTION aqlan_hr_identity_link_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'hr identity links cannot be deleted'; END IF;
  IF OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR NEW.closed_event_id IS NULL
    OR (to_jsonb(NEW) - 'closed_at' - 'closed_event_id') IS DISTINCT FROM
       (to_jsonb(OLD) - 'closed_at' - 'closed_event_id') THEN
    RAISE EXCEPTION 'hr identity link may only be closed once with evidence';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_account_link_history BEFORE UPDATE OR DELETE ON hr_staff_account_links
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_identity_link_history();
CREATE TRIGGER hr_party_link_history BEFORE UPDATE OR DELETE ON hr_staff_party_links
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_identity_link_history();

CREATE FUNCTION aqlan_hr_identity_legacy_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.identity_revision < OLD.identity_revision OR NEW.identity_revision > OLD.identity_revision + 1 THEN
    RAISE EXCEPTION 'identity revision must advance one step';
  END IF;
  IF OLD.identity_revision > 0 AND (NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.user_linked_at IS DISTINCT FROM OLD.user_linked_at) THEN
    RAISE EXCEPTION 'converted identity preserves the legacy access link';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_identity_legacy_guard BEFORE UPDATE ON hr_staff
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_identity_legacy_guard();

CREATE FUNCTION aqlan_hr_identity_party_kind() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM parties WHERE id=NEW.party_id AND kind IN ('doctor','employee')) THEN
    RAISE EXCEPTION 'hr financial identity requires doctor or employee party';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_identity_party_kind BEFORE INSERT ON hr_staff_party_links
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_identity_party_kind();

CREATE FUNCTION aqlan_hr_request_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id OR NEW.identity_evidence IS DISTINCT FROM OLD.identity_evidence THEN
    RAISE EXCEPTION 'request identity evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER hr_leave_identity_immutable BEFORE UPDATE ON hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_request_identity_immutable();
CREATE TRIGGER hr_correction_identity_immutable BEFORE UPDATE ON hr_attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_request_identity_immutable();
