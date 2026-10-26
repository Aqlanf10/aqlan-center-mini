/** Unnumbered proposal; explicitly installed only in synthetic fixtures. */
export const INVENTORY_COMMAND_LIFECYCLE_SQL = `
CREATE TABLE IF NOT EXISTS inventory_command_bindings (
 scope TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), operation_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 realm_id TEXT NOT NULL CHECK(length(realm_id) BETWEEN 1 AND 240),
 subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 240),
 username TEXT NOT NULL, management BOOLEAN NOT NULL,
 created_xid XID8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(scope,actor_id,operation_key),
 UNIQUE(scope,actor_id,operation_key,payload_hash)
);
CREATE TABLE IF NOT EXISTS inventory_command_retirements (
 scope TEXT NOT NULL, actor_id INTEGER NOT NULL, operation_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 2000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(scope,actor_id,operation_key),
 FOREIGN KEY(scope,actor_id,operation_key,payload_hash)
 REFERENCES inventory_command_bindings(scope,actor_id,operation_key,payload_hash)
);
DO $guards$ DECLARE rel TEXT; BEGIN
 FOREACH rel IN ARRAY ARRAY['inventory_command_bindings','inventory_command_retirements'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=rel||'_immutable' AND tgrelid=to_regclass(rel)) THEN
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION inventory_procurement_append_only()',rel||'_immutable',rel);
 END IF; END LOOP;
END $guards$;
CREATE OR REPLACE FUNCTION inventory_command_terminal_guard() RETURNS TRIGGER AS $guard$
BEGIN
 -- Same exact advisory identity as application execution, including legacy callers.
 PERFORM pg_advisory_xact_lock(hashtextextended(
   '['||to_json(NEW.scope)::text||','||NEW.actor_id::text||','||to_json(NEW.operation_key)::text||']',0));
 IF TG_TABLE_NAME='inventory_operations' THEN
  IF EXISTS(SELECT 1 FROM inventory_command_retirements WHERE scope=NEW.scope AND actor_id=NEW.actor_id AND operation_key=NEW.operation_key) THEN
   RAISE EXCEPTION 'Retired inventory command cannot commit a result';
  END IF;
  IF EXISTS(SELECT 1 FROM inventory_command_bindings WHERE scope=NEW.scope AND actor_id=NEW.actor_id AND operation_key=NEW.operation_key AND payload_hash<>NEW.payload_hash) THEN
   RAISE EXCEPTION 'Inventory command binding payload mismatch';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM inventory_operations WHERE scope=NEW.scope AND actor_id=NEW.actor_id AND operation_key=NEW.operation_key) THEN
   RAISE EXCEPTION 'Committed inventory command cannot be adopted or retired';
  END IF;
 END IF;
 RETURN NEW;
END $guard$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS inventory_command_binding_guard ON inventory_command_bindings;
CREATE TRIGGER inventory_command_binding_guard BEFORE INSERT ON inventory_command_bindings
 FOR EACH ROW EXECUTE FUNCTION inventory_command_terminal_guard();
DROP TRIGGER IF EXISTS inventory_command_retirement_guard ON inventory_command_retirements;
CREATE TRIGGER inventory_command_retirement_guard BEFORE INSERT ON inventory_command_retirements
 FOR EACH ROW EXECUTE FUNCTION inventory_command_terminal_guard();
DROP TRIGGER IF EXISTS inventory_command_result_guard ON inventory_operations;
CREATE TRIGGER inventory_command_result_guard BEFORE INSERT ON inventory_operations
 FOR EACH ROW EXECUTE FUNCTION inventory_command_terminal_guard();
`;
