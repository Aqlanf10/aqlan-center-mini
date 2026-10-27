/** Unnumbered identity DDL only. Bootstrap is explicit; no request provisions schema. */
export const STAFF_AUTHORITY_SQL = String.raw`
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_subject_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS users_staff_subject_identity ON users(staff_subject_id);
CREATE TABLE IF NOT EXISTS staff_execution_epochs (
 id UUID PRIMARY KEY, reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 2000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS staff_authority_identity (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 realm_id UUID NOT NULL UNIQUE,
 execution_epoch_id UUID NOT NULL REFERENCES staff_execution_epochs(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION staff_subject_identity_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
 IF NEW.staff_subject_id IS DISTINCT FROM OLD.staff_subject_id THEN
  RAISE EXCEPTION 'Staff subject identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS users_subject_identity_immutable ON users;
CREATE TRIGGER users_subject_identity_immutable BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION staff_subject_identity_immutable();
CREATE OR REPLACE FUNCTION staff_realm_identity_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
 IF TG_OP='DELETE' OR NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.realm_id IS DISTINCT FROM OLD.realm_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Staff realm identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS staff_realm_identity_immutable ON staff_authority_identity;
CREATE TRIGGER staff_realm_identity_immutable BEFORE UPDATE OR DELETE ON staff_authority_identity FOR EACH ROW EXECUTE FUNCTION staff_realm_identity_immutable();
CREATE OR REPLACE FUNCTION staff_execution_epoch_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'Staff execution epochs are append-only' USING ERRCODE='23514'; END $fn$;
DROP TRIGGER IF EXISTS staff_execution_epoch_immutable ON staff_execution_epochs;
CREATE TRIGGER staff_execution_epoch_immutable BEFORE UPDATE OR DELETE ON staff_execution_epochs FOR EACH ROW EXECUTE FUNCTION staff_execution_epoch_immutable();
`;
