/** Candidate only: deliberately unnumbered and NOT installed by ensureSchema.
 * Runtime/reset/backup registration must be coordinated before activation. */
export const APPOINTMENT_FOLLOWUP_SQL = `
CREATE TABLE appointment_followups (
  id SERIAL PRIMARY KEY,
  source_appointment_id INTEGER NOT NULL CHECK (source_appointment_id > 0),
  source_created_at TEXT NOT NULL CHECK (source_created_at ~ '^[0-9]{1,12}\\.[0-9]{6}$'),
  generation TEXT NOT NULL CHECK (generation ~ '^[a-f0-9]{32}$'),
  assignee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending','no_answer','awaiting_reply','rebooking_review','declined','resolved')),
  next_step TEXT NOT NULL CHECK (next_step IN ('call','review','none')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_appointment_id, source_created_at, generation),
  CHECK ((status = 'closed') = (outcome IN ('declined','resolved'))),
  CHECK ((status = 'closed') = (next_step = 'none')),
  CHECK (outcome <> 'rebooking_review' OR next_step = 'review')
);
CREATE INDEX appointment_followups_queue_idx ON appointment_followups (due_at, id) WHERE status = 'open';
CREATE TABLE appointment_followup_links (
  followup_id INTEGER PRIMARY KEY REFERENCES appointment_followups(id) ON DELETE RESTRICT,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL
);
CREATE TABLE appointment_followup_events (
  id SERIAL PRIMARY KEY,
  followup_id INTEGER NOT NULL REFERENCES appointment_followups(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  assignee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending','no_answer','awaiting_reply','rebooking_review','declined','resolved')),
  next_step TEXT NOT NULL CHECK (next_step IN ('call','review','none')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (followup_id, revision),
  UNIQUE (actor_user_id, request_id),
  UNIQUE (id, actor_user_id, request_id, fingerprint),
  CHECK ((status = 'closed') = (outcome IN ('declined','resolved'))),
  CHECK ((status = 'closed') = (next_step = 'none')),
  CHECK (outcome <> 'rebooking_review' OR next_step = 'review')
);
CREATE TABLE appointment_followup_receipts (
  actor_user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  event_id INTEGER NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id, request_id),
  FOREIGN KEY (event_id, actor_user_id, request_id, fingerprint)
    REFERENCES appointment_followup_events(id, actor_user_id, request_id, fingerprint) ON DELETE RESTRICT
);
CREATE FUNCTION aqlan_followup_source_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW.id, NEW.source_appointment_id, NEW.source_created_at, NEW.generation, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.source_appointment_id, OLD.source_created_at, OLD.generation, OLD.created_at)
    THEN
    RAISE EXCEPTION 'followup source identity is immutable';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_followup_source_immutable BEFORE UPDATE ON appointment_followups
  FOR EACH ROW EXECUTE FUNCTION aqlan_followup_source_immutable();
CREATE FUNCTION aqlan_followup_link_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM appointment_followup_events WHERE followup_id=NEW.followup_id)
      OR NOT EXISTS (SELECT 1 FROM appointment_followups f JOIN appointments a
        ON a.id=f.source_appointment_id AND EXTRACT(EPOCH FROM a.created_at)::text=f.source_created_at
        WHERE f.id=NEW.followup_id AND a.id=NEW.appointment_id AND a.patient_id=NEW.patient_id) THEN
      RAISE EXCEPTION 'followup live source is immutable';
    END IF;
  ELSIF NEW.followup_id IS DISTINCT FROM OLD.followup_id
    OR (NEW.appointment_id IS DISTINCT FROM OLD.appointment_id AND NEW.appointment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'followup live source is immutable';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_followup_link_immutable BEFORE INSERT OR UPDATE ON appointment_followup_links
  FOR EACH ROW EXECUTE FUNCTION aqlan_followup_link_immutable();
CREATE FUNCTION aqlan_followup_history_immutable() RETURNS TRIGGER AS $$
BEGIN
  -- Cooperate with an empty-table reset only; any existing history is protected.
  IF TG_OP = 'TRUNCATE' THEN
    IF TG_TABLE_NAME = 'appointment_followup_events' AND NOT EXISTS (SELECT 1 FROM appointment_followup_events) THEN RETURN NULL; END IF;
    IF TG_TABLE_NAME = 'appointment_followup_receipts' AND NOT EXISTS (SELECT 1 FROM appointment_followup_receipts) THEN RETURN NULL; END IF;
  END IF;
  RAISE EXCEPTION 'followup history is append-only';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_followup_events_immutable BEFORE UPDATE OR DELETE ON appointment_followup_events
  FOR EACH ROW EXECUTE FUNCTION aqlan_followup_history_immutable();
CREATE TRIGGER appointment_followup_events_no_truncate BEFORE TRUNCATE ON appointment_followup_events
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_followup_history_immutable();
CREATE TRIGGER appointment_followup_receipts_immutable BEFORE UPDATE OR DELETE ON appointment_followup_receipts
  FOR EACH ROW EXECUTE FUNCTION aqlan_followup_history_immutable();
CREATE TRIGGER appointment_followup_receipts_no_truncate BEFORE TRUNCATE ON appointment_followup_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_followup_history_immutable();
`;
