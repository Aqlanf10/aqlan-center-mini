-- 0076: target-owned authority metadata and monotonic revocation epochs.
-- Installing this NEVER appoints an owner, converts grants, or activates canonical access.
-- Local reservation reviewed in acceptance/migration-local-reservations-0075-0076-20261026.json.
ALTER TABLE users ADD COLUMN IF NOT EXISTS authorization_mode TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE users ADD COLUMN IF NOT EXISTS authorization_epoch BIGINT NOT NULL DEFAULT 1;
ALTER TABLE parties ADD COLUMN IF NOT EXISTS clinical_authority_epoch BIGINT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS staff_authority_control (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  state TEXT NOT NULL DEFAULT 'unbound' CHECK (state IN ('unbound','prepared','active','quarantined','prepared-recovery')),
  realm_id TEXT NOT NULL DEFAULT gen_random_uuid()::text CHECK (realm_id ~ '^[a-f0-9-]{36}$'),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  pending_owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  binding_epoch BIGINT NOT NULL DEFAULT 1 CHECK (binding_epoch > 0),
  conversion_digest TEXT,
  recovery_reference TEXT,
  prepared_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  CHECK (
    (state IN ('unbound','quarantined') AND owner_user_id IS NULL AND pending_owner_user_id IS NULL)
    OR (state IN ('prepared','prepared-recovery') AND owner_user_id IS NULL AND pending_owner_user_id IS NOT NULL
      AND conversion_digest IS NOT NULL AND recovery_reference IS NOT NULL
      AND conversion_digest ~ '^[a-f0-9]{64}$' AND length(recovery_reference) BETWEEN 1 AND 200)
    OR (state = 'active' AND owner_user_id IS NOT NULL AND pending_owner_user_id IS NULL
      AND conversion_digest IS NOT NULL AND recovery_reference IS NOT NULL
      AND conversion_digest ~ '^[a-f0-9]{64}$' AND length(recovery_reference) BETWEEN 1 AND 200)
  )
);
INSERT INTO staff_authority_control (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION staff_authority_control_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_row RECORD;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'staff authority control cannot be removed';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.realm_id IS DISTINCT FROM OLD.realm_id THEN RAISE EXCEPTION 'target authority realm is immutable'; END IF;
    IF OLD.state = 'active' AND NEW.state <> 'active' THEN
      RAISE EXCEPTION 'active staff authority cannot return to legacy mode';
    END IF;
    IF OLD.state IN ('quarantined','prepared-recovery') AND NEW.state NOT IN ('quarantined','prepared-recovery','active') THEN
      RAISE EXCEPTION 'restored authority cannot return to legacy mode';
    END IF;
    IF NEW.state = 'active' AND OLD.state NOT IN ('prepared','prepared-recovery','active') THEN
      RAISE EXCEPTION 'owner activation requires explicit preparation';
    END IF;
    IF NEW.state = 'prepared-recovery' AND OLD.state NOT IN ('quarantined','prepared-recovery') THEN
      RAISE EXCEPTION 'owner recovery requires a quarantined target';
    END IF;
    NEW.binding_epoch := OLD.binding_epoch + 1;
  ELSE
    IF NEW.state <> 'unbound' THEN RAISE EXCEPTION 'new authority control must be unbound'; END IF;
    NEW.realm_id := gen_random_uuid()::text;
    NEW.binding_epoch := 1;
  END IF;
  IF NEW.state IN ('prepared','prepared-recovery') THEN
    SELECT role, is_active INTO account_row FROM users WHERE id=NEW.pending_owner_user_id FOR SHARE;
    IF NOT FOUND OR account_row.role <> 'admin' OR NOT account_row.is_active THEN
      RAISE EXCEPTION 'pending owner must be explicitly selected active administrator';
    END IF;
  END IF;
  IF NEW.state = 'active' THEN
    SELECT role, is_active, authorization_mode INTO account_row FROM users WHERE id = NEW.owner_user_id FOR SHARE;
    IF NOT FOUND OR account_row.role <> 'admin' OR NOT account_row.is_active OR account_row.authorization_mode <> 'canonical' THEN
      RAISE EXCEPTION 'owner must be an explicitly bound active canonical administrator';
    END IF;
    IF EXISTS (SELECT 1 FROM users WHERE authorization_mode <> 'canonical') THEN
      RAISE EXCEPTION 'activation requires an explicit conversion for every account';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS staff_authority_control_guard_row ON staff_authority_control;
CREATE TRIGGER staff_authority_control_guard_row BEFORE INSERT OR UPDATE OR DELETE ON staff_authority_control
  FOR EACH ROW EXECUTE FUNCTION staff_authority_control_guard();
DROP TRIGGER IF EXISTS staff_authority_control_guard_truncate ON staff_authority_control;
CREATE TRIGGER staff_authority_control_guard_truncate BEFORE TRUNCATE ON staff_authority_control
  FOR EACH STATEMENT EXECUTE FUNCTION staff_authority_control_guard();

CREATE OR REPLACE FUNCTION staff_account_authority_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE control RECORD;
BEGIN
  SELECT state, owner_user_id INTO control FROM staff_authority_control WHERE singleton FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'staff authority control missing'; END IF;
  IF TG_OP = 'DELETE' THEN
    IF control.owner_user_id = OLD.id THEN RAISE EXCEPTION 'owner account is protected'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.authorization_mode NOT IN ('legacy','canonical') THEN RAISE EXCEPTION 'invalid staff authority mode'; END IF;
  IF control.state = 'active' AND NEW.authorization_mode <> 'canonical' THEN
    RAISE EXCEPTION 'legacy staff authority is disabled';
  END IF;
  IF control.owner_user_id = NEW.id AND (NOT NEW.is_active OR NEW.role <> 'admin') THEN
    RAISE EXCEPTION 'owner account cannot be disabled or demoted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.authorization_epoch := GREATEST(NEW.authorization_epoch, 1);
  ELSE
    IF OLD.authorization_mode = 'canonical' AND NEW.authorization_mode <> 'canonical' THEN
      RAISE EXCEPTION 'canonical staff authority cannot downgrade';
    END IF;
    NEW.authorization_epoch := OLD.authorization_epoch;
    IF ROW(NEW.username,NEW.password_hash,NEW.role,NEW.is_active,NEW.party_id,NEW.permissions,NEW.authorization_mode)
      IS DISTINCT FROM ROW(OLD.username,OLD.password_hash,OLD.role,OLD.is_active,OLD.party_id,OLD.permissions,OLD.authorization_mode) THEN
      NEW.authorization_epoch := OLD.authorization_epoch + 1;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS staff_account_authority_epoch ON users;
CREATE TRIGGER staff_account_authority_epoch BEFORE INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION staff_account_authority_epoch_guard();

CREATE OR REPLACE FUNCTION staff_clinical_authority_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN NEW.clinical_authority_epoch := GREATEST(NEW.clinical_authority_epoch, 1);
  ELSE
    NEW.clinical_authority_epoch := OLD.clinical_authority_epoch;
    IF ROW(NEW.kind, NEW.is_active) IS DISTINCT FROM ROW(OLD.kind, OLD.is_active) THEN
      NEW.clinical_authority_epoch := OLD.clinical_authority_epoch + 1;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS staff_clinical_authority_epoch ON parties;
CREATE TRIGGER staff_clinical_authority_epoch BEFORE INSERT OR UPDATE ON parties
  FOR EACH ROW EXECUTE FUNCTION staff_clinical_authority_epoch_guard();
