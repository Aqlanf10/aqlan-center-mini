CREATE TABLE IF NOT EXISTS patient_portal_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  operating_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (
    operating_mode IN ('disabled', 'sandbox_test', 'live_enabled')
  ),
  allow_whatsapp_channel BOOLEAN NOT NULL DEFAULT TRUE,
  allow_sms_channel BOOLEAN NOT NULL DEFAULT TRUE,
  allow_in_person_channel BOOLEAN NOT NULL DEFAULT TRUE,
  recovery_phone_policy TEXT NOT NULL DEFAULT 'disallow_inline' CHECK (
    recovery_phone_policy IN (
      'disallow_inline',
      'owner_only',
      'admin_or_owner_only',
      'portal_manager_in_person'
    )
  ),
  post_merge_target_policy TEXT NOT NULL DEFAULT 'suspend_target' CHECK (
    post_merge_target_policy IN (
      'suspend_target',
      'suspend_on_conflict_or_dual',
      'keep_target_revoke_sessions'
    )
  ),
  activation_ttl_minutes INTEGER NOT NULL DEFAULT 60 CHECK (
    activation_ttl_minutes BETWEEN 5 AND 1440
  ),
  reset_ttl_minutes INTEGER NOT NULL DEFAULT 30 CHECK (
    reset_ttl_minutes BETWEEN 5 AND 1440
  ),
  in_person_reset_ttl_minutes INTEGER NOT NULL DEFAULT 15 CHECK (
    in_person_reset_ttl_minutes BETWEEN 5 AND 180
  ),
  session_ttl_hours INTEGER NOT NULL DEFAULT 72 CHECK (
    session_ttl_hours BETWEEN 1 AND 720
  ),
  admin_preview_ttl_minutes INTEGER NOT NULL DEFAULT 30 CHECK (
    admin_preview_ttl_minutes BETWEEN 5 AND 120
  ),
  max_token_attempts INTEGER NOT NULL DEFAULT 5 CHECK (
    max_token_attempts BETWEEN 3 AND 10
  ),
  max_failed_login_attempts INTEGER NOT NULL DEFAULT 5 CHECK (
    max_failed_login_attempts BETWEEN 3 AND 15
  ),
  login_failure_window_minutes INTEGER NOT NULL DEFAULT 15 CHECK (
    login_failure_window_minutes BETWEEN 5 AND 120
  ),
  account_lockout_minutes INTEGER NOT NULL DEFAULT 15 CHECK (
    account_lockout_minutes BETWEEN 5 AND 1440
  ),
  show_profile BOOLEAN NOT NULL DEFAULT TRUE,
  show_appointments BOOLEAN NOT NULL DEFAULT TRUE,
  allow_appointment_confirm BOOLEAN NOT NULL DEFAULT TRUE,
  show_booking_link BOOLEAN NOT NULL DEFAULT TRUE,
  show_visits BOOLEAN NOT NULL DEFAULT TRUE,
  show_treatment_plans BOOLEAN NOT NULL DEFAULT TRUE,
  show_statement BOOLEAN NOT NULL DEFAULT TRUE,
  show_prescriptions BOOLEAN NOT NULL DEFAULT TRUE,
  show_documents BOOLEAN NOT NULL DEFAULT TRUE,
  show_xray_documents BOOLEAN NOT NULL DEFAULT FALSE,
  show_intake BOOLEAN NOT NULL DEFAULT TRUE,
  show_messages BOOLEAN NOT NULL DEFAULT TRUE,
  allow_message_attachments BOOLEAN NOT NULL DEFAULT TRUE,
  allow_voice_messages BOOLEAN NOT NULL DEFAULT TRUE,
  show_announcements BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_message_retention_mode TEXT NOT NULL DEFAULT 'retain_indefinitely_pending_owner_policy' CHECK (
    deleted_message_retention_mode IN ('retain_indefinitely_pending_owner_policy')
  ),
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE patient_portal_accounts
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  ADD COLUMN IF NOT EXISTS first_failed_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lock_reason TEXT CHECK (lock_reason IS NULL OR char_length(lock_reason) <= 200);

ALTER TABLE patient_portal_staff_grants
  ADD COLUMN IF NOT EXISTS can_configure_portal_settings BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS can_issue_activation BOOLEAN,
  ADD COLUMN IF NOT EXISTS can_issue_reset BOOLEAN,
  ADD COLUMN IF NOT EXISTS can_change_recovery_phone BOOLEAN,
  ADD COLUMN IF NOT EXISTS can_manage_portal_announcements BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS patient_portal_announcements (
  id BIGSERIAL PRIMARY KEY,
  title_ar TEXT NOT NULL CHECK (char_length(btrim(title_ar)) BETWEEN 2 AND 140),
  body_ar TEXT NOT NULL CHECK (char_length(btrim(body_ar)) BETWEEN 4 AND 800),
  title_en TEXT CHECK (title_en IS NULL OR char_length(btrim(title_en)) <= 140),
  body_en TEXT CHECK (body_en IS NULL OR char_length(btrim(body_en)) <= 800),
  badge_label TEXT CHECK (badge_label IS NULL OR char_length(btrim(badge_label)) <= 40),
  tone TEXT NOT NULL DEFAULT 'sky' CHECK (tone IN ('sky', 'navy', 'accent', 'emerald', 'amber')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  is_sample BOOLEAN NOT NULL DEFAULT FALSE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT patient_portal_announcements_window_valid CHECK (
    starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at
  )
);

CREATE INDEX IF NOT EXISTS patient_portal_announcements_active_order_idx
  ON patient_portal_announcements (is_active, sort_order ASC, id DESC);
