/** Unregistered quarantine-only proposal. No installer runs on import or reads. */
export const STAFF_IDENTITY_SUBSTRATE_VERSION = 1;
export const FROZEN_0076_SHA256 = "f31ddf1462dc8d5db3c321b08044f58464f9af0be4b3b1088222a45fb5ebe0da";
export function staffIdentitySchemaName(value = "public") {
  if (typeof value !== "string" || (value !== "public" && !/^aqlan_identity_[a-f0-9]{16}$/.test(value))) throw new Error("STAFF_IDENTITY_SCHEMA_INVALID");
  return value;
}
export const IDENTITY_TABLES = Object.freeze([
  "staff_identity_generations", "staff_identity_subjects", "staff_identity_state",
  "staff_identity_binding_events", "staff_identity_current",
]);
export function substrateFunctions(schema = "public") {
  const s = staffIdentitySchemaName(schema);
  return {
    staff_identity_history_guard: `BEGIN RAISE EXCEPTION 'staff identity history is immutable'; END`,
    staff_identity_state_guard: `DECLARE g RECORD; BEGIN
      IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'staff identity state cannot be removed'; END IF;
      IF NEW.status <> 'quarantined' THEN RAISE EXCEPTION 'identity substrate cannot authorize sessions'; END IF;
      SELECT * INTO g FROM ${s}.staff_identity_generations WHERE generation_id=NEW.generation_id;
      IF NOT FOUND OR g.realm_id <> NEW.realm_id THEN RAISE EXCEPTION 'identity generation mismatch'; END IF;
      IF TG_OP='INSERT' THEN
        IF NEW.registry_revision<>1 OR g.previous_generation_id IS NOT NULL OR g.reason<>'initialize' THEN RAISE EXCEPTION 'invalid initial identity state'; END IF;
      ELSE
        IF NEW.realm_id<>OLD.realm_id OR NEW.registry_revision<>OLD.registry_revision+1 THEN RAISE EXCEPTION 'invalid identity state revision'; END IF;
        IF NEW.generation_id<>OLD.generation_id AND g.previous_generation_id IS DISTINCT FROM OLD.generation_id THEN RAISE EXCEPTION 'invalid identity generation chain'; END IF;
      END IF;
      RETURN NEW;
    END`,
    staff_identity_subject_guard: `DECLARE h RECORD; BEGIN
      SELECT * INTO h FROM ${s}.staff_identity_state WHERE singleton FOR SHARE;
      IF NOT FOUND OR h.status<>'quarantined' OR NEW.realm_id<>h.realm_id OR NEW.created_generation_id<>h.generation_id OR NEW.created_registry_revision<>h.registry_revision THEN RAISE EXCEPTION 'invalid subject provenance'; END IF;
      RETURN NEW;
    END`,
    staff_identity_event_guard: `DECLARE h RECORD; old_subject RECORD; new_subject RECORD; BEGIN
      SELECT * INTO h FROM ${s}.staff_identity_state WHERE singleton FOR SHARE;
      IF NOT FOUND OR h.status<>'quarantined' OR NEW.generation_id<>h.generation_id OR NEW.registry_revision<>h.registry_revision THEN RAISE EXCEPTION 'invalid binding event state'; END IF;
      IF NEW.previous_subject_id IS NOT NULL THEN
        SELECT * INTO old_subject FROM ${s}.staff_identity_subjects WHERE subject_id=NEW.previous_subject_id;
        IF NOT FOUND OR old_subject.realm_id<>h.realm_id OR old_subject.user_id_at_binding<>NEW.user_id THEN RAISE EXCEPTION 'invalid previous binding subject'; END IF;
        IF NOT EXISTS(SELECT 1 FROM ${s}.staff_identity_current WHERE user_id=NEW.user_id AND subject_id=NEW.previous_subject_id) THEN RAISE EXCEPTION 'binding event old subject mismatch'; END IF;
      ELSIF EXISTS(SELECT 1 FROM ${s}.staff_identity_current WHERE user_id=NEW.user_id) THEN RAISE EXCEPTION 'binding event omitted old subject'; END IF;
      IF NEW.new_subject_id IS NOT NULL THEN
        SELECT * INTO new_subject FROM ${s}.staff_identity_subjects WHERE subject_id=NEW.new_subject_id;
        IF NOT FOUND OR new_subject.realm_id<>h.realm_id OR new_subject.user_id_at_binding<>NEW.user_id OR new_subject.created_generation_id<>h.generation_id OR new_subject.created_registry_revision<>h.registry_revision THEN RAISE EXCEPTION 'historical subject cannot be rebound'; END IF;
      END IF;
      RETURN NEW;
    END`,
    staff_identity_current_guard: `DECLARE h RECORD; e RECORD; BEGIN
      IF TG_OP IN ('UPDATE','TRUNCATE') THEN RAISE EXCEPTION 'current identity binding cannot be updated or truncated'; END IF;
      SELECT * INTO h FROM ${s}.staff_identity_state WHERE singleton FOR SHARE;
      IF NOT FOUND OR h.status<>'quarantined' THEN RAISE EXCEPTION 'current binding requires quarantine'; END IF;
      SELECT * INTO e FROM ${s}.staff_identity_binding_events WHERE registry_revision=h.registry_revision;
      IF NOT FOUND OR e.generation_id<>h.generation_id THEN RAISE EXCEPTION 'current binding requires exact event'; END IF;
      IF TG_OP='DELETE' THEN
        IF e.user_id<>OLD.user_id OR e.previous_subject_id IS DISTINCT FROM OLD.subject_id THEN RAISE EXCEPTION 'current binding retirement mismatch'; END IF;
        RETURN OLD;
      END IF;
      IF e.user_id<>NEW.user_id OR e.new_subject_id IS DISTINCT FROM NEW.subject_id OR NEW.bound_registry_revision<>h.registry_revision THEN RAISE EXCEPTION 'current binding creation mismatch'; END IF;
      RETURN NEW;
    END`,
  };
}
export function staffIdentitySubstrateSql(schema = "public") {
  const s = staffIdentitySchemaName(schema);
  const tables = `
CREATE TABLE ${s}.staff_identity_generations (
 generation_id UUID PRIMARY KEY, realm_id UUID NOT NULL, previous_generation_id UUID REFERENCES ${s}.staff_identity_generations(generation_id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(reason IN ('initialize','reset','restore')),
 CHECK((reason='initialize')=(previous_generation_id IS NULL))
);
CREATE TABLE ${s}.staff_identity_subjects (
 subject_id UUID PRIMARY KEY, realm_id UUID NOT NULL, user_id_at_binding INTEGER NOT NULL CHECK(user_id_at_binding>0),
 created_generation_id UUID NOT NULL REFERENCES ${s}.staff_identity_generations(generation_id) ON DELETE RESTRICT,
 created_registry_revision BIGINT NOT NULL CHECK(created_registry_revision>1)
);
CREATE TABLE ${s}.staff_identity_state (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), realm_id UUID NOT NULL,
 generation_id UUID NOT NULL REFERENCES ${s}.staff_identity_generations(generation_id) ON DELETE RESTRICT,
 registry_revision BIGINT NOT NULL CHECK(registry_revision>0), status TEXT NOT NULL CHECK(status='quarantined')
);
CREATE TABLE ${s}.staff_identity_binding_events (
 registry_revision BIGINT PRIMARY KEY CHECK(registry_revision>1), generation_id UUID NOT NULL REFERENCES ${s}.staff_identity_generations(generation_id) ON DELETE RESTRICT,
 user_id INTEGER NOT NULL CHECK(user_id>0), previous_subject_id UUID REFERENCES ${s}.staff_identity_subjects(subject_id) ON DELETE RESTRICT,
 new_subject_id UUID UNIQUE REFERENCES ${s}.staff_identity_subjects(subject_id) ON DELETE RESTRICT,
 CHECK(previous_subject_id IS DISTINCT FROM new_subject_id)
);
CREATE TABLE ${s}.staff_identity_current (
 user_id INTEGER PRIMARY KEY REFERENCES ${s}.users(id) ON DELETE RESTRICT,
 subject_id UUID NOT NULL UNIQUE REFERENCES ${s}.staff_identity_subjects(subject_id) ON DELETE RESTRICT,
 bound_registry_revision BIGINT NOT NULL UNIQUE REFERENCES ${s}.staff_identity_binding_events(registry_revision) ON DELETE RESTRICT
);`;
  const functions = Object.entries(substrateFunctions(s)).map(([name, body]) =>
    `CREATE FUNCTION ${s}.${name}() RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, ${s} AS $identity$${body}$identity$;`).join("\n");
  const triggers = [];
  for (const table of ["staff_identity_generations", "staff_identity_subjects", "staff_identity_binding_events"]) {
    triggers.push(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${s}.${table} FOR EACH ROW EXECUTE FUNCTION ${s}.staff_identity_history_guard();`);
    triggers.push(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${s}.${table} FOR EACH STATEMENT EXECUTE FUNCTION ${s}.staff_identity_history_guard();`);
  }
  for (const [table, events, fn] of [
    ["staff_identity_state", "INSERT OR UPDATE OR DELETE", "staff_identity_state_guard"],
    ["staff_identity_subjects", "INSERT", "staff_identity_subject_guard"],
    ["staff_identity_binding_events", "INSERT", "staff_identity_event_guard"],
    ["staff_identity_current", "INSERT OR UPDATE OR DELETE", "staff_identity_current_guard"],
  ]) triggers.push(`CREATE TRIGGER ${table}_guard BEFORE ${events} ON ${s}.${table} FOR EACH ROW EXECUTE FUNCTION ${s}.${fn}();`);
  for (const [table, fn] of [["staff_identity_state", "staff_identity_state_guard"], ["staff_identity_current", "staff_identity_current_guard"]])
    triggers.push(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${s}.${table} FOR EACH STATEMENT EXECUTE FUNCTION ${s}.${fn}();`);
  return [tables, functions, ...triggers].join("\n");
}
