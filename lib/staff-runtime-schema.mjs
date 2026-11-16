import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";

export const STAFF_RUNTIME_SCHEMA_VERSION = 2;
/** Unregistered proposal only. Applying it does NOT seal ready, appoint an owner,
 * grant capabilities, issue a credential or authorize source restoration. */
export function staffRuntimeSchemaSql(schema = "public") {
  const s = staffIdentitySchemaName(schema);
  return `
ALTER TABLE ${s}.staff_identity_state DROP CONSTRAINT staff_identity_state_status_check;
ALTER TABLE ${s}.staff_identity_state ADD COLUMN ready_owner_subject_id UUID REFERENCES ${s}.staff_identity_subjects(subject_id) ON DELETE RESTRICT;
ALTER TABLE ${s}.staff_identity_state ADD COLUMN ready_control_epoch BIGINT;
ALTER TABLE ${s}.staff_identity_state ADD CONSTRAINT staff_identity_state_v2_readiness CHECK (
 (status='quarantined' AND ready_owner_subject_id IS NULL AND ready_control_epoch IS NULL)
 OR (status='ready' AND ready_owner_subject_id IS NOT NULL AND ready_control_epoch IS NOT NULL AND ready_control_epoch>0)
);
CREATE OR REPLACE FUNCTION ${s}.staff_identity_state_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, ${s} AS $runtime$
DECLARE g RECORD; c RECORD; b RECORD;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'staff identity state cannot be removed'; END IF;
 SELECT * INTO g FROM ${s}.staff_identity_generations WHERE generation_id=NEW.generation_id;
 IF NOT FOUND OR g.realm_id<>NEW.realm_id THEN RAISE EXCEPTION 'identity generation mismatch'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'quarantined' OR NEW.registry_revision<>1 OR g.previous_generation_id IS NOT NULL OR g.reason<>'initialize' THEN RAISE EXCEPTION 'v2 initialization remains quarantined'; END IF;
 ELSIF OLD.status='ready' THEN
  RAISE EXCEPTION 'ready identity mutation requires a separately reviewed lifecycle';
 ELSIF NEW.status='ready' THEN
  IF NEW.realm_id<>OLD.realm_id OR NEW.generation_id<>OLD.generation_id OR NEW.registry_revision<>OLD.registry_revision THEN RAISE EXCEPTION 'ready seal cannot mutate identity history'; END IF;
  SELECT * INTO c FROM ${s}.staff_authority_control WHERE singleton FOR SHARE;
  IF NOT FOUND OR c.state<>'active' OR c.realm_id<>NEW.realm_id::text OR c.binding_epoch IS DISTINCT FROM NEW.ready_control_epoch THEN RAISE EXCEPTION 'ready seal requires exact active control'; END IF;
  SELECT * INTO b FROM ${s}.staff_identity_current WHERE user_id=c.owner_user_id;
  IF NOT FOUND OR b.subject_id IS DISTINCT FROM NEW.ready_owner_subject_id THEN RAISE EXCEPTION 'ready owner incarnation mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM ${s}.users u LEFT JOIN ${s}.staff_identity_current i ON i.user_id=u.id WHERE u.authorization_mode<>'canonical' OR i.user_id IS NULL) THEN RAISE EXCEPTION 'ready seal requires complete canonical account bindings'; END IF;
 ELSIF NEW.status='quarantined' THEN
  IF NEW.realm_id<>OLD.realm_id OR NEW.registry_revision<>OLD.registry_revision+1 THEN RAISE EXCEPTION 'invalid identity state revision'; END IF;
  IF NEW.generation_id<>OLD.generation_id AND g.previous_generation_id IS DISTINCT FROM OLD.generation_id THEN RAISE EXCEPTION 'invalid identity generation chain'; END IF;
 ELSE
  RAISE EXCEPTION 'unsupported identity state';
 END IF;
 RETURN NEW;
END
$runtime$;`;
}
