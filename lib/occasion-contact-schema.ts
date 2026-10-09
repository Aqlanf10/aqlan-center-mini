/**
 * Unpublished schema proposal for issue 303. Intentionally NOT registered,
 * numbered, imported by ensureSchema, or executed. Review against the real
 * PostgreSQL schema/roles before allocating an ordinary migration.
 *
 * No patient FK: endpoint STOP and immutable evidence survive patient deletion.
 * IDs/evidence are server-produced opaque references, never raw message bodies.
 */
export const OCCASION_CONTACT_SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS messaging_endpoint_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 200),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  endpoint text NOT NULL CHECK (
    (channel IN ('whatsapp', 'sms') AND endpoint ~ '^[1-9][0-9]{7,14}$') OR
    (channel = 'email' AND length(endpoint) BETWEEN 3 AND 254
      AND endpoint = lower(endpoint)
      AND endpoint !~ '[[:space:][:cntrl:]]' AND endpoint ~ '^[^@]+@[^@]+$')
  ),
  kind text NOT NULL CHECK (kind IN ('stop', 'resubscribe')),
  target_stop_event_id text,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 300),
  evidence_id text NOT NULL CHECK (length(evidence_id) BETWEEN 1 AND 200),
  authentication_evidence_id text NOT NULL CHECK (length(authentication_evidence_id) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source, source_event_id),
  UNIQUE (channel, endpoint, event_id),
  CHECK ((kind = 'stop' AND target_stop_event_id IS NULL) OR
    (kind = 'resubscribe' AND target_stop_event_id IS NOT NULL)),
  FOREIGN KEY (channel, endpoint, target_stop_event_id)
    REFERENCES messaging_endpoint_events(channel, endpoint, event_id)
);
CREATE INDEX IF NOT EXISTS messaging_endpoint_latest_stop_idx
  ON messaging_endpoint_events(channel, endpoint, sequence DESC) WHERE kind = 'stop';
CREATE INDEX IF NOT EXISTS messaging_endpoint_resubscribe_idx
  ON messaging_endpoint_events(channel, endpoint, target_stop_event_id, sequence DESC)
  WHERE kind = 'resubscribe';

-- These are additive side tables; existing patient data is not changed/backfilled.
-- Every patient contact edit/merge/deletion must rotate/retire the pointer in the
-- same transaction as its existing operation before campaign sends can be enabled.
CREATE TABLE IF NOT EXISTS patient_contact_revision_events (
  contact_revision text PRIMARY KEY CHECK (length(contact_revision) BETWEEN 1 AND 200),
  patient_id bigint NOT NULL CHECK (patient_id > 0),
  previous_contact_revision text,
  reason text NOT NULL CHECK (reason IN
    ('initialize', 'contact_change', 'merge_survivor', 'merge_retired', 'patient_deleted')),
  active boolean NOT NULL,
  evidence_id text NOT NULL CHECK (length(evidence_id) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (patient_id, contact_revision),
  CHECK ((reason = 'initialize') = (previous_contact_revision IS NULL)),
  CHECK (active = (reason IN ('initialize', 'contact_change', 'merge_survivor'))),
  FOREIGN KEY (patient_id, previous_contact_revision)
    REFERENCES patient_contact_revision_events(patient_id, contact_revision)
);
CREATE TABLE IF NOT EXISTS patient_contact_revisions (
  patient_id bigint PRIMARY KEY CHECK (patient_id > 0),
  contact_revision text NOT NULL UNIQUE,
  FOREIGN KEY (patient_id, contact_revision)
    REFERENCES patient_contact_revision_events(patient_id, contact_revision)
);

CREATE TABLE IF NOT EXISTS occasion_permission_events (
  event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 200),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  patient_id bigint NOT NULL CHECK (patient_id > 0),
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  endpoint text NOT NULL CHECK (endpoint ~ '^[1-9][0-9]{7,14}$'),
  purpose text NOT NULL CHECK (purpose = 'occasion'),
  contact_revision text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('granted', 'withdrawn')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN
    ('explicit_occasion_opt_in', 'explicit_occasion_withdrawal')),
  evidence_id text NOT NULL CHECK (length(evidence_id) BETWEEN 1 AND 200),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 300),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source, source_event_id),
  CHECK ((decision = 'granted' AND evidence_kind = 'explicit_occasion_opt_in') OR
    (decision = 'withdrawn' AND evidence_kind = 'explicit_occasion_withdrawal')),
  FOREIGN KEY (patient_id, contact_revision)
    REFERENCES patient_contact_revision_events(patient_id, contact_revision)
);
CREATE INDEX IF NOT EXISTS occasion_permission_latest_idx ON occasion_permission_events
  (patient_id, channel, endpoint, purpose, contact_revision, sequence DESC);

-- Defense in depth for immutable evidence. Privileged schema owners can still
-- bypass triggers; operational roles must not own/alter these tables/triggers.
CREATE OR REPLACE FUNCTION reject_messaging_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'messaging evidence is append-only';
END;
$$;
-- Run the whole schema constant atomically when it is eventually registered.
-- Trigger replacement affects metadata only; no evidence/data is removed.
DROP TRIGGER IF EXISTS messaging_endpoint_events_immutable ON messaging_endpoint_events;
CREATE TRIGGER messaging_endpoint_events_immutable
  BEFORE UPDATE OR DELETE ON messaging_endpoint_events
  FOR EACH ROW EXECUTE FUNCTION reject_messaging_evidence_mutation();
DROP TRIGGER IF EXISTS messaging_endpoint_events_no_truncate ON messaging_endpoint_events;
CREATE TRIGGER messaging_endpoint_events_no_truncate
  BEFORE TRUNCATE ON messaging_endpoint_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_messaging_evidence_mutation();
DROP TRIGGER IF EXISTS patient_contact_revision_events_immutable ON patient_contact_revision_events;
CREATE TRIGGER patient_contact_revision_events_immutable
  BEFORE UPDATE OR DELETE ON patient_contact_revision_events
  FOR EACH ROW EXECUTE FUNCTION reject_messaging_evidence_mutation();
DROP TRIGGER IF EXISTS patient_contact_revision_events_no_truncate ON patient_contact_revision_events;
CREATE TRIGGER patient_contact_revision_events_no_truncate
  BEFORE TRUNCATE ON patient_contact_revision_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_messaging_evidence_mutation();
DROP TRIGGER IF EXISTS patient_contact_revisions_no_delete ON patient_contact_revisions;
CREATE TRIGGER patient_contact_revisions_no_delete
  BEFORE DELETE ON patient_contact_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_messaging_evidence_mutation();
DROP TRIGGER IF EXISTS patient_contact_revisions_no_truncate ON patient_contact_revisions;
CREATE TRIGGER patient_contact_revisions_no_truncate
  BEFORE TRUNCATE ON patient_contact_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_messaging_evidence_mutation();
DROP TRIGGER IF EXISTS occasion_permission_events_immutable ON occasion_permission_events;
CREATE TRIGGER occasion_permission_events_immutable
  BEFORE UPDATE OR DELETE ON occasion_permission_events
  FOR EACH ROW EXECUTE FUNCTION reject_messaging_evidence_mutation();
DROP TRIGGER IF EXISTS occasion_permission_events_no_truncate ON occasion_permission_events;
CREATE TRIGGER occasion_permission_events_no_truncate
  BEFORE TRUNCATE ON occasion_permission_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_messaging_evidence_mutation();
`;
