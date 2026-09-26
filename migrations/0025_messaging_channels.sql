-- (MSG-1) Messaging channels (WhatsApp, SMS gateway, email) and the delivery log.
-- Body must remain byte-for-byte equal to MESSAGING_CHANNELS_SQL after these comments.
CREATE TABLE IF NOT EXISTS messaging_channels (
  channel           TEXT        PRIMARY KEY CHECK (channel IN ('whatsapp', 'sms', 'email')),
  enabled           BOOLEAN     NOT NULL DEFAULT FALSE,
  config            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  secret_enc        TEXT,
  last_test_at      TIMESTAMPTZ,
  last_test_ok      BOOLEAN,
  last_test_message TEXT,
  updated_by        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id                  SERIAL      PRIMARY KEY,
  channel             TEXT        NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  direction           TEXT        NOT NULL DEFAULT 'out' CHECK (direction IN ('out', 'in')),
  patient_id          INTEGER     REFERENCES patients(id) ON DELETE SET NULL,
  counterpart         TEXT        NOT NULL,
  subject             TEXT,
  body                TEXT        NOT NULL,
  purpose             TEXT        NOT NULL DEFAULT 'manual',
  status              TEXT        NOT NULL CHECK (status IN ('sent', 'failed', 'received')),
  provider_message_id TEXT,
  error               TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS message_deliveries_patient_idx ON message_deliveries (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_deliveries_created_idx ON message_deliveries (created_at DESC);
CREATE INDEX IF NOT EXISTS message_deliveries_counterpart_idx ON message_deliveries (channel, counterpart, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS message_deliveries_provider_idx
  ON message_deliveries (channel, provider_message_id) WHERE provider_message_id IS NOT NULL;
