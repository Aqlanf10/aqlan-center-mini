/** Applied explicitly after the procurement, supplier finance and lifecycle proposals. */
export const INVENTORY_SUPPLIER_TRANSPORT_SQL = String.raw`
CREATE TABLE IF NOT EXISTS inventory_supplier_intents (
 realm_id UUID NOT NULL, subject_id UUID NOT NULL, intent_nonce UUID NOT NULL,
 execution_epoch_id UUID NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id),
 operation_key TEXT NOT NULL, scope TEXT NOT NULL, request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
 envelope JSONB NOT NULL CHECK(jsonb_typeof(envelope)='object'), envelope_digest TEXT NOT NULL CHECK(length(envelope_digest)=64),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(realm_id,subject_id,intent_nonce), UNIQUE(scope,actor_id,operation_key),
 FOREIGN KEY(scope,actor_id,operation_key) REFERENCES inventory_command_bindings(scope,actor_id,operation_key) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS inventory_supplier_intents_invoice ON inventory_supplier_intents ((envelope->'input'->>'invoiceId'));
CREATE TABLE IF NOT EXISTS inventory_supplier_intent_rejections (
 realm_id UUID NOT NULL, subject_id UUID NOT NULL, intent_nonce UUID NOT NULL,
 execution_epoch_id UUID NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id),
 intent JSONB NOT NULL CHECK(jsonb_typeof(intent)='object'), request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 2000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(realm_id,subject_id,intent_nonce)
);
-- Identity columns are opaque, immutable evidence (M3a). Admission writes the CURRENT
-- canonical realm, subject and identity generation proved by the runtime; execution,
-- replay and retirement require that exact triple again. There is deliberately no
-- foreign key to identity tables: a restored target owns a fresh realm, so source
-- rows are foreign history that must stay inert (never re-bound, never executed,
-- see docs/inventory/CANONICAL-RESTORE-PROTOCOL-20261028.md), not rejected rows.
-- The former foreign key to the parallel staff_execution_epochs schema is retired.
CREATE OR REPLACE FUNCTION inventory_supplier_nonce_exclusive() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('["supplier.intent",' || to_json(NEW.realm_id::text)::text || ',' || to_json(NEW.subject_id::text)::text || ',' || to_json(NEW.intent_nonce::text)::text || ']',0));
 IF TG_TABLE_NAME='inventory_supplier_intents' AND EXISTS(SELECT 1 FROM inventory_supplier_intent_rejections WHERE realm_id=NEW.realm_id AND subject_id=NEW.subject_id AND intent_nonce=NEW.intent_nonce)
 OR TG_TABLE_NAME='inventory_supplier_intent_rejections' AND EXISTS(SELECT 1 FROM inventory_supplier_intents WHERE realm_id=NEW.realm_id AND subject_id=NEW.subject_id AND intent_nonce=NEW.intent_nonce) THEN
 RAISE EXCEPTION 'Supplier nonce already has a terminal/admitted outcome' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS inventory_supplier_nonce_exclusive ON inventory_supplier_intents;
CREATE TRIGGER inventory_supplier_nonce_exclusive BEFORE INSERT ON inventory_supplier_intents FOR EACH ROW EXECUTE FUNCTION inventory_supplier_nonce_exclusive();
DROP TRIGGER IF EXISTS inventory_supplier_nonce_exclusive ON inventory_supplier_intent_rejections;
CREATE TRIGGER inventory_supplier_nonce_exclusive BEFORE INSERT ON inventory_supplier_intent_rejections FOR EACH ROW EXECUTE FUNCTION inventory_supplier_nonce_exclusive();
DROP TRIGGER IF EXISTS inventory_supplier_rejection_immutable ON inventory_supplier_intent_rejections;
CREATE TRIGGER inventory_supplier_rejection_immutable BEFORE UPDATE OR DELETE ON inventory_supplier_intent_rejections FOR EACH ROW EXECUTE FUNCTION inventory_procurement_append_only();
DROP TRIGGER IF EXISTS inventory_supplier_intents_immutable ON inventory_supplier_intents;
CREATE TRIGGER inventory_supplier_intents_immutable BEFORE UPDATE OR DELETE ON inventory_supplier_intents FOR EACH ROW EXECUTE FUNCTION inventory_procurement_append_only();
`;
