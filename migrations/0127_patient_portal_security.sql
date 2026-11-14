CREATE TABLE IF NOT EXISTS patient_portal_accounts (
  patient_id INTEGER PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  login_name TEXT NOT NULL CHECK (
    char_length(btrim(login_name)) BETWEEN 3 AND 64
    AND login_name ~ '^[A-Za-z0-9._-]+$'
  ),
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending_activation' CHECK (
    status IN ('pending_activation', 'active', 'disabled')
  ),
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version >= 1),
  sessions_revoked_at TIMESTAMPTZ,
  phone_fingerprint TEXT,
  activated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ,
  password_updated_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  disabled_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  disabled_reason TEXT CHECK (disabled_reason IS NULL OR char_length(disabled_reason) <= 300),
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT patient_portal_accounts_active_requires_secret CHECK (
    status <> 'active' OR password_hash IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS patient_portal_accounts_login_lower_idx
  ON patient_portal_accounts (LOWER(login_name));

CREATE TABLE IF NOT EXISTS patient_portal_tokens (
  id BIGSERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  purpose TEXT NOT NULL CHECK (purpose IN ('activate', 'reset', 'in_person_reset')),
  delivery_channel TEXT NOT NULL CHECK (delivery_channel IN ('whatsapp', 'sms', 'in_person')),
  phone_fingerprint TEXT,
  issued_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verification_note TEXT CHECK (verification_note IS NULL OR char_length(verification_note) <= 500),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  invalidation_reason TEXT CHECK (invalidation_reason IS NULL OR char_length(invalidation_reason) <= 120),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS patient_portal_tokens_patient_purpose_idx
  ON patient_portal_tokens (patient_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS patient_portal_staff_grants (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  can_manage_portal BOOLEAN NOT NULL DEFAULT FALSE,
  can_preview_portal BOOLEAN NOT NULL DEFAULT FALSE,
  granted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
