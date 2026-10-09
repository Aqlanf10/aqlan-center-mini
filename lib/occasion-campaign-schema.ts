/**
 * Unregistered additive SQL contract for review only. No migration number is allocated.
 * Contact/STOP contract must be composed first. Do not execute or register this packet.
 */
export const OCCASION_CAMPAIGN_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS occasion_campaigns (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel = 'whatsapp'),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','queued','running','cancelled','dispatch_complete','needs_attention')),
  draft_revision BIGINT NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  draft_template JSONB NOT NULL CHECK (jsonb_typeof(draft_template) = 'object'),
  preview_intent_canonical TEXT,
  preview_intent_sha256 TEXT CHECK (preview_intent_sha256 IS NULL OR preview_intent_sha256 ~ '^[a-f0-9]{64}$'),
  preview_revision BIGINT,
  authorization_id TEXT UNIQUE,
  authorized_intent_canonical TEXT,
  authorized_intent_sha256 TEXT CHECK (authorized_intent_sha256 IS NULL OR authorized_intent_sha256 ~ '^[a-f0-9]{64}$'),
  send_request_key TEXT,
  approved_template JSONB,
  provider_binding JSONB,
  approved_content_digest TEXT,
  reviewed_generic_occasion BOOLEAN NOT NULL DEFAULT FALSE,
  authorized_by TEXT,
  authorized_at TIMESTAMPTZ,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  lease_id TEXT,
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at TIMESTAMPTZ,
  last_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK (state IN ('draft','cancelled') OR authorization_id IS NOT NULL),
  CHECK (state <> 'draft' OR authorization_id IS NULL),
  CHECK (authorization_id IS NULL OR (
    authorized_intent_canonical IS NOT NULL AND authorized_intent_sha256 IS NOT NULL AND send_request_key IS NOT NULL
    AND approved_template IS NOT NULL AND provider_binding IS NOT NULL AND approved_content_digest IS NOT NULL
    AND reviewed_generic_occasion AND authorized_by IS NOT NULL AND authorized_at IS NOT NULL)),
  CHECK (approved_template IS NULL OR (jsonb_typeof(approved_template) = 'object' AND NOT approved_template ?| ARRAY['secret','token','password','channel'])),
  CHECK (provider_binding IS NULL OR (jsonb_typeof(provider_binding) = 'object' AND NOT provider_binding ?| ARRAY['secret','token','password']))
);
CREATE UNIQUE INDEX IF NOT EXISTS occasion_campaigns_send_request_idx
  ON occasion_campaigns(authorized_by, send_request_key) WHERE send_request_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS occasion_campaigns_authorization_binding_idx
  ON occasion_campaigns(id, authorization_id);

CREATE TABLE IF NOT EXISTS occasion_campaign_send_requests (
  actor TEXT NOT NULL,
  request_key TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES occasion_campaigns(id) ON DELETE RESTRICT,
  draft_revision BIGINT NOT NULL CHECK (draft_revision > 0),
  intent_sha256 TEXT NOT NULL CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'),
  authorization_id TEXT NOT NULL REFERENCES occasion_campaigns(authorization_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(actor, request_key),
  FOREIGN KEY(campaign_id, authorization_id) REFERENCES occasion_campaigns(id, authorization_id)
);

CREATE TABLE IF NOT EXISTS occasion_campaign_batches (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES occasion_campaigns(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  generation BIGINT NOT NULL CHECK (generation > 0),
  actor TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  terminal_reason TEXT,
  UNIQUE(campaign_id, request_key),
  UNIQUE(campaign_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS occasion_campaign_batches_binding_idx ON occasion_campaign_batches(campaign_id, lease_id);

CREATE TABLE IF NOT EXISTS occasion_campaign_recipients (
  id BIGSERIAL PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES occasion_campaigns(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel = 'whatsapp'),
  patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL CHECK (endpoint ~ '^[1-9][0-9]{7,14}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  contact_revision TEXT NOT NULL,
  consent_event_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','accepted','sent','delivered','read','rejected','failed','uncertain','cancelled','suppressed')),
  current_attempt_id TEXT,
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR (length(provider_message_id) BETWEEN 1 AND 512 AND btrim(provider_message_id)=provider_message_id)),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  last_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, endpoint),
  CHECK (snapshot ?& ARRAY['patientId','channel','purpose','endpoint','contactRevision','consentEventId']
    AND jsonb_typeof(snapshot->'patientId')='number'
    AND jsonb_typeof(snapshot->'endpoint')='string' AND jsonb_typeof(snapshot->'channel')='string'
    AND jsonb_typeof(snapshot->'purpose')='string' AND jsonb_typeof(snapshot->'contactRevision')='string'
    AND jsonb_typeof(snapshot->'consentEventId')='string'
    AND (patient_id IS NULL OR (snapshot->>'patientId')::bigint=patient_id)
    AND snapshot->>'endpoint' = endpoint AND snapshot->>'channel' = channel AND snapshot->>'purpose' = 'occasion'
    AND snapshot->>'contactRevision' = contact_revision AND snapshot->>'consentEventId' = consent_event_id),
  CHECK (
    (state IN ('queued','cancelled') AND current_attempt_id IS NULL AND provider_message_id IS NULL AND NOT retryable)
    OR (state = 'claimed' AND current_attempt_id IS NOT NULL AND provider_message_id IS NULL AND NOT retryable)
    OR (state IN ('accepted','sent','delivered','read','failed') AND current_attempt_id IS NOT NULL AND provider_message_id IS NOT NULL AND NOT retryable)
    OR (state = 'rejected' AND current_attempt_id IS NOT NULL AND provider_message_id IS NULL)
    OR (state = 'uncertain' AND current_attempt_id IS NOT NULL AND NOT retryable)
    OR (state = 'suppressed' AND provider_message_id IS NULL AND NOT retryable)
  )
);
CREATE INDEX IF NOT EXISTS occasion_campaign_recipients_pending_idx
  ON occasion_campaign_recipients(campaign_id, id) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS occasion_campaign_recipients_endpoint_idx
  ON occasion_campaign_recipients(channel, endpoint, state);
CREATE UNIQUE INDEX IF NOT EXISTS occasion_campaign_one_claim_idx
  ON occasion_campaign_recipients(campaign_id) WHERE state='claimed';
CREATE UNIQUE INDEX IF NOT EXISTS occasion_campaign_recipients_binding_idx ON occasion_campaign_recipients(campaign_id, id);

CREATE TABLE IF NOT EXISTS occasion_campaign_attempts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES occasion_campaigns(id) ON DELETE RESTRICT,
  recipient_id BIGINT NOT NULL REFERENCES occasion_campaign_recipients(id) ON DELETE RESTRICT,
  authorization_id TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES occasion_campaign_batches(lease_id) ON DELETE RESTRICT,
  provider_scope_digest TEXT NOT NULL,
  sender_phone_number_id TEXT NOT NULL,
  result_state TEXT NOT NULL DEFAULT 'claimed' CHECK (result_state IN ('claimed','accepted','rejected','uncertain')),
  provider_message_id TEXT CHECK (provider_message_id IS NULL OR (length(provider_message_id) BETWEEN 1 AND 512 AND btrim(provider_message_id)=provider_message_id)),
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  receipt_evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(receipt_evidence) = 'array' AND jsonb_array_length(receipt_evidence) <= 2),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  FOREIGN KEY(campaign_id, authorization_id) REFERENCES occasion_campaigns(id, authorization_id),
  FOREIGN KEY(campaign_id, lease_id) REFERENCES occasion_campaign_batches(campaign_id, lease_id),
  FOREIGN KEY(campaign_id, recipient_id) REFERENCES occasion_campaign_recipients(campaign_id, id),
  CHECK (
    (result_state = 'claimed' AND provider_message_id IS NULL AND NOT retryable AND finished_at IS NULL)
    OR (result_state = 'accepted' AND provider_message_id IS NOT NULL AND NOT retryable AND finished_at IS NOT NULL)
    OR (result_state = 'rejected' AND provider_message_id IS NULL AND finished_at IS NOT NULL)
    OR (result_state = 'uncertain' AND NOT retryable AND finished_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS occasion_campaign_attempts_receipt_idx
  ON occasion_campaign_attempts(sender_phone_number_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS occasion_campaign_attempts_recipient_idx ON occasion_campaign_attempts(recipient_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS occasion_campaign_attempts_binding_idx ON occasion_campaign_attempts(recipient_id, campaign_id, id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'occasion_campaign_recipients'::regclass AND conname = 'occasion_current_attempt_fk') THEN
    ALTER TABLE occasion_campaign_recipients ADD CONSTRAINT occasion_current_attempt_fk
      FOREIGN KEY (id, campaign_id, current_attempt_id) REFERENCES occasion_campaign_attempts(recipient_id, campaign_id, id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION aqlan_occasion_request_guard() RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'Send request replay evidence is immutable.';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS occasion_request_guard ON occasion_campaign_send_requests;
CREATE TRIGGER occasion_request_guard BEFORE UPDATE OR DELETE ON occasion_campaign_send_requests FOR EACH ROW EXECUTE FUNCTION aqlan_occasion_request_guard();

CREATE OR REPLACE FUNCTION aqlan_occasion_batch_guard() RETURNS trigger AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Batch lease evidence is retained.'; END IF;
  IF (to_jsonb(NEW) - ARRAY['completed_at','terminal_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['completed_at','terminal_reason'])
  THEN RAISE EXCEPTION 'Batch lease identity is immutable.'; END IF;
  IF OLD.completed_at IS NOT NULL AND (NEW.completed_at IS DISTINCT FROM OLD.completed_at OR NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
  THEN RAISE EXCEPTION 'Completed batch evidence is immutable.'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS occasion_batch_guard ON occasion_campaign_batches;
CREATE TRIGGER occasion_batch_guard BEFORE UPDATE OR DELETE ON occasion_campaign_batches FOR EACH ROW EXECUTE FUNCTION aqlan_occasion_batch_guard();

CREATE OR REPLACE FUNCTION aqlan_occasion_campaign_guard() RETURNS trigger AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Occasion campaign evidence is retained.'; END IF;
  IF OLD.authorization_id IS NOT NULL AND
    (to_jsonb(NEW) - ARRAY['state','cancel_requested','lease_id','lease_generation','lease_expires_at','last_reason','updated_at'])
      IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['state','cancel_requested','lease_id','lease_generation','lease_expires_at','last_reason','updated_at'])
  THEN RAISE EXCEPTION 'Authorized campaign fields are immutable.'; END IF;
  IF NEW.lease_generation < OLD.lease_generation THEN RAISE EXCEPTION 'Lease generation cannot move backwards.'; END IF;
  IF OLD.cancel_requested AND NOT NEW.cancel_requested THEN RAISE EXCEPTION 'Cancelled campaign cannot be reactivated.'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS occasion_campaign_guard ON occasion_campaigns;
CREATE TRIGGER occasion_campaign_guard BEFORE UPDATE OR DELETE ON occasion_campaigns FOR EACH ROW EXECUTE FUNCTION aqlan_occasion_campaign_guard();

CREATE OR REPLACE FUNCTION aqlan_occasion_attempt_guard() RETURNS trigger AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Occasion attempt evidence is retained.'; END IF;
  IF (to_jsonb(NEW) - ARRAY['result_state','provider_message_id','retryable','receipt_evidence','finished_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['result_state','provider_message_id','retryable','receipt_evidence','finished_at'])
  THEN RAISE EXCEPTION 'Attempt identity cannot be rebound.'; END IF;
  IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
  THEN RAISE EXCEPTION 'Provider receipt evidence cannot be erased or replaced.'; END IF;
  IF NOT NEW.receipt_evidence @> OLD.receipt_evidence THEN RAISE EXCEPTION 'Diagnostic receipt evidence cannot be erased.'; END IF;
  IF OLD.result_state = 'accepted' AND NEW.result_state <> 'accepted' THEN RAISE EXCEPTION 'Acceptance cannot become retryable.'; END IF;
  IF OLD.result_state = 'uncertain' AND NEW.result_state IN ('claimed','rejected') THEN RAISE EXCEPTION 'Uncertainty cannot authorize a retry.'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS occasion_attempt_guard ON occasion_campaign_attempts;
CREATE TRIGGER occasion_attempt_guard BEFORE UPDATE OR DELETE ON occasion_campaign_attempts FOR EACH ROW EXECUTE FUNCTION aqlan_occasion_attempt_guard();

CREATE OR REPLACE FUNCTION aqlan_occasion_recipient_guard() RETURNS trigger AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Occasion recipient evidence is retained.'; END IF;
  IF (to_jsonb(NEW) - ARRAY['patient_id','state','current_attempt_id','provider_message_id','retryable','last_reason','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['patient_id','state','current_attempt_id','provider_message_id','retryable','last_reason','updated_at'])
  THEN RAISE EXCEPTION 'Approved recipient snapshot cannot change.'; END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id AND NEW.patient_id IS NOT NULL THEN RAISE EXCEPTION 'Recipient cannot transfer to another patient.'; END IF;
  IF OLD.provider_message_id IS NOT NULL AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
  THEN RAISE EXCEPTION 'Accepted recipient evidence cannot be erased.'; END IF;
  IF NEW.state = 'queued' AND OLD.state <> 'queued' AND (OLD.state <> 'rejected' OR NOT OLD.retryable)
  THEN RAISE EXCEPTION 'Only definitely rejected retryable work can requeue.'; END IF;
  IF NEW.state IN ('queued','claimed') AND EXISTS (
    SELECT 1 FROM occasion_campaign_attempts a WHERE a.recipient_id = NEW.id
      AND (a.provider_message_id IS NOT NULL OR a.result_state IN ('accepted','uncertain'))
  ) THEN RAISE EXCEPTION 'Prior acceptance or uncertainty prevents dispatch.'; END IF;
  IF NEW.current_attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM occasion_campaign_attempts a WHERE a.id = NEW.current_attempt_id AND a.recipient_id = NEW.id AND a.campaign_id = NEW.campaign_id
  ) THEN RAISE EXCEPTION 'Attempt belongs to a different recipient.'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS occasion_recipient_guard ON occasion_campaign_recipients;
CREATE TRIGGER occasion_recipient_guard BEFORE UPDATE OR DELETE ON occasion_campaign_recipients FOR EACH ROW EXECUTE FUNCTION aqlan_occasion_recipient_guard();

-- Defense in depth; database owners can bypass triggers. Operational roles must
-- not own/alter these tables. Review restore/disposable-fixture compatibility.
CREATE OR REPLACE FUNCTION aqlan_occasion_reject_truncate() RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'Occasion dispatch history cannot be truncated.';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS occasion_campaign_no_truncate ON occasion_campaigns;
CREATE TRIGGER occasion_campaign_no_truncate BEFORE TRUNCATE ON occasion_campaigns FOR EACH STATEMENT EXECUTE FUNCTION aqlan_occasion_reject_truncate();
DROP TRIGGER IF EXISTS occasion_request_no_truncate ON occasion_campaign_send_requests;
CREATE TRIGGER occasion_request_no_truncate BEFORE TRUNCATE ON occasion_campaign_send_requests FOR EACH STATEMENT EXECUTE FUNCTION aqlan_occasion_reject_truncate();
DROP TRIGGER IF EXISTS occasion_batch_no_truncate ON occasion_campaign_batches;
CREATE TRIGGER occasion_batch_no_truncate BEFORE TRUNCATE ON occasion_campaign_batches FOR EACH STATEMENT EXECUTE FUNCTION aqlan_occasion_reject_truncate();
DROP TRIGGER IF EXISTS occasion_recipient_no_truncate ON occasion_campaign_recipients;
CREATE TRIGGER occasion_recipient_no_truncate BEFORE TRUNCATE ON occasion_campaign_recipients FOR EACH STATEMENT EXECUTE FUNCTION aqlan_occasion_reject_truncate();
DROP TRIGGER IF EXISTS occasion_attempt_no_truncate ON occasion_campaign_attempts;
CREATE TRIGGER occasion_attempt_no_truncate BEFORE TRUNCATE ON occasion_campaign_attempts FOR EACH STATEMENT EXECUTE FUNCTION aqlan_occasion_reject_truncate();`;
