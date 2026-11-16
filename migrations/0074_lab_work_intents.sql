-- 0074 locally reserved: explicit lab identity and restore-safe deferred graph.
-- Lab-only local candidate; registration and deployment require combined review.
-- Original plan geometry only: amended/authorized replacement sources remain unsupported.
-- No dependency on deferred clinical authorization migration 0073 or cross-domain 0075.
-- Requires coordinated source-writer, replay, correction and deletion guards.
-- No legacy backfill, no financial writes, no release of identity on cancellation.

CREATE TABLE lab_work_intents (
  id UUID PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE NO ACTION,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('visit','invoice')),
  origin_visit_id INTEGER REFERENCES visits(id) ON DELETE NO ACTION,
  origin_invoice_id INTEGER REFERENCES invoices(id) ON DELETE NO ACTION,
  group_kind TEXT NOT NULL CHECK (group_kind IN ('single','bridge')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','materialized','cancelled')),
  prescription JSONB NOT NULL CHECK (jsonb_typeof(prescription) = 'object'),
  initial_order_id INTEGER UNIQUE REFERENCES lab_orders(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,patient_id),
  CHECK ((origin_kind='visit' AND origin_visit_id IS NOT NULL AND origin_invoice_id IS NULL)
      OR (origin_kind='invoice' AND origin_invoice_id IS NOT NULL AND origin_visit_id IS NULL)),
  CHECK (state <> 'materialized' OR initial_order_id IS NOT NULL),
  CHECK (state <> 'draft' OR initial_order_id IS NULL)
);

-- Explicit identity replaces visit/tooth dedup ONLY for new intent-bearing orders.
ALTER TABLE lab_orders ADD COLUMN lab_work_intent_id UUID UNIQUE REFERENCES lab_work_intents(id) ON DELETE NO ACTION;
DROP INDEX IF EXISTS lab_orders_visit_tooth_uniq;
CREATE UNIQUE INDEX lab_orders_visit_tooth_uniq ON lab_orders(visit_id,tooth_code)
  WHERE visit_id IS NOT NULL AND status <> 'cancelled' AND lab_work_intent_id IS NULL;

CREATE TABLE lab_work_members (
  id UUID PRIMARY KEY,
  intent_id UUID NOT NULL,
  patient_id INTEGER NOT NULL,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE NO ACTION,
  source_category TEXT NOT NULL CHECK (source_category IN ('crown','bridge','veneer')),
  tooth_code INTEGER NOT NULL CHECK (
    tooth_code BETWEEN 11 AND 18 OR tooth_code BETWEEN 21 AND 28 OR
    tooth_code BETWEEN 31 AND 38 OR tooth_code BETWEEN 41 AND 48 OR
    tooth_code BETWEEN 51 AND 55 OR tooth_code BETWEEN 61 AND 65 OR
    tooth_code BETWEEN 71 AND 75 OR tooth_code BETWEEN 81 AND 85),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 64),
  plan_item_id INTEGER REFERENCES plan_items(id) ON DELETE NO ACTION,
  doctor_id INTEGER REFERENCES parties(id) ON DELETE NO ACTION,
  created_revision INTEGER NOT NULL CHECK (created_revision > 0),
  retired_revision INTEGER CHECK (retired_revision >= created_revision),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,intent_id),
  UNIQUE (id,intent_id,patient_id),
  FOREIGN KEY (intent_id,patient_id) REFERENCES lab_work_intents(id,patient_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX lab_work_members_intent_idx ON lab_work_members(intent_id,id);

-- Draft rows may be replaced. These point TO durable identities, never the reverse.
ALTER TABLE visit_procedures ADD COLUMN lab_work_intent_id UUID;
ALTER TABLE visit_procedures ADD COLUMN lab_work_member_id UUID;
ALTER TABLE visit_procedures ADD CONSTRAINT visit_procedure_lab_identity_pair
  CHECK ((lab_work_intent_id IS NULL) = (lab_work_member_id IS NULL));
ALTER TABLE visit_procedures ADD CONSTRAINT visit_procedure_lab_member_fk
  FOREIGN KEY (lab_work_member_id,lab_work_intent_id)
  REFERENCES lab_work_members(id,intent_id) ON DELETE NO ACTION;
CREATE UNIQUE INDEX visit_procedure_lab_member_per_visit
  ON visit_procedures(visit_id,lab_work_member_id) WHERE lab_work_member_id IS NOT NULL;

CREATE TABLE lab_prescription_source_memberships (
  id BIGSERIAL PRIMARY KEY,
  intent_id UUID NOT NULL,
  member_id UUID NOT NULL,
  patient_id INTEGER NOT NULL,
  plan_item_id INTEGER UNIQUE REFERENCES plan_items(id) ON DELETE NO ACTION,
  visit_procedure_id BIGINT UNIQUE REFERENCES visit_procedures(id) ON DELETE NO ACTION,
  invoice_item_id INTEGER UNIQUE REFERENCES invoice_items(id) ON DELETE NO ACTION,
  linked_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(plan_item_id,visit_procedure_id,invoice_item_id)=1),
  FOREIGN KEY (member_id,intent_id,patient_id)
    REFERENCES lab_work_members(id,intent_id,patient_id) ON DELETE NO ACTION
);
CREATE INDEX lab_prescription_sources_intent_idx ON lab_prescription_source_memberships(intent_id,id);

CREATE TABLE lab_work_commands (
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  request_key TEXT NOT NULL CHECK (request_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE NO ACTION,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('visit','invoice')),
  source_id INTEGER NOT NULL CHECK (source_id > 0),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result JSONB NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id,request_key)
);
-- source_id here is an immutable audit scope, not a source-membership FK. The
-- source transaction validates it and stores the complete original response.
-- Writer MUST resolve same actor/key/hash replay before expected-revision checks.

-- Fence both parent-first application writes and parent-last isolated restore.
-- The identical transaction-scoped key is acquired BEFORE observing the parent.
-- No other transaction can supply a parent for an unresolved historical edge.
CREATE FUNCTION aqlan_lab_intent_insert_lock() RETURNS TRIGGER AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('lab-intent'),hashtext(NEW.id::text)) THEN
    RAISE EXCEPTION 'lab identity is busy; retry the complete transaction' USING ERRCODE='55P03';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
CREATE TRIGGER lab_intent_insert_lock BEFORE INSERT ON lab_work_intents
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_intent_insert_lock();

CREATE FUNCTION aqlan_lab_intent_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'lab work identity cannot be deleted'; END IF;
  IF ROW(NEW.id,NEW.patient_id,NEW.origin_kind,NEW.origin_visit_id,NEW.origin_invoice_id,
         NEW.group_kind,NEW.created_by_user_id,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.patient_id,OLD.origin_kind,OLD.origin_visit_id,OLD.origin_invoice_id,
         OLD.group_kind,OLD.created_by_user_id,OLD.created_at)
     OR NEW.revision <> OLD.revision + 1
     OR (OLD.initial_order_id IS NOT NULL AND NEW.initial_order_id IS DISTINCT FROM OLD.initial_order_id)
     OR (OLD.state='cancelled')
     OR (OLD.state='materialized' AND NEW.state NOT IN ('materialized','cancelled'))
     OR ((OLD.state <> 'draft' OR OLD.initial_order_id IS NOT NULL) AND NEW.prescription IS DISTINCT FROM OLD.prescription)
  THEN RAISE EXCEPTION 'lab work identity or materialized specification is immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lab_intent_immutable BEFORE UPDATE OR DELETE ON lab_work_intents
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_intent_immutable();

CREATE FUNCTION aqlan_lab_member_scope() RETURNS TRIGGER AS $$
DECLARE intent_row lab_work_intents%ROWTYPE; plan_patient INTEGER;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('lab-intent'),hashtext(NEW.intent_id::text)) THEN
    RAISE EXCEPTION 'lab identity is busy; retry the complete transaction' USING ERRCODE='55P03';
  END IF;
  SELECT * INTO intent_row FROM lab_work_intents WHERE id=NEW.intent_id FOR UPDATE;
  IF NOT FOUND THEN
    -- VOLATILE READ COMMITTED lookup observes every parent committed before
    -- acquiring this key. Only this transaction may now insert a missing parent.
    -- Stable stale snapshots cannot establish absence and must fail closed.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'lab historical graph requires READ COMMITTED identity admission';
    END IF;
    RETURN NEW;
  END IF;
  IF intent_row.patient_id<>NEW.patient_id OR intent_row.state<>'draft'
    OR intent_row.initial_order_id IS NOT NULL OR NEW.created_revision<>intent_row.revision
    OR NEW.retired_revision IS NOT NULL
    THEN RAISE EXCEPTION 'lab member requires current active draft identity'; END IF;
  IF (intent_row.group_kind='bridge') IS DISTINCT FROM (NEW.source_category='bridge')
    OR (intent_row.group_kind='single' AND (NEW.quantity<>1 OR EXISTS (
      SELECT 1 FROM lab_work_members WHERE intent_id=NEW.intent_id AND retired_revision IS NULL)))
    THEN RAISE EXCEPTION 'lab member conflicts with explicit group kind'; END IF;
  IF NEW.plan_item_id IS NOT NULL THEN
    SELECT p.patient_id INTO plan_patient FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE i.id=NEW.plan_item_id;
    IF plan_patient IS DISTINCT FROM NEW.patient_id THEN RAISE EXCEPTION 'lab member plan patient mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
CREATE TRIGGER lab_member_scope BEFORE INSERT ON lab_work_members
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_member_scope();

-- Historical edges are admissible only if the COMPLETE final graph is valid.
CREATE FUNCTION aqlan_lab_member_graph() RETURNS TRIGGER AS $$
DECLARE parent lab_work_intents%ROWTYPE; plan_patient INTEGER; provider_kind TEXT;
BEGIN
  SELECT * INTO parent FROM lab_work_intents WHERE id=NEW.intent_id;
  IF NOT FOUND OR parent.patient_id<>NEW.patient_id
    OR NEW.created_revision>parent.revision
    OR (NEW.retired_revision IS NOT NULL AND (NEW.retired_revision<NEW.created_revision OR NEW.retired_revision>parent.revision))
    OR (parent.group_kind='bridge') IS DISTINCT FROM (NEW.source_category='bridge')
    OR (parent.group_kind='single' AND NEW.quantity<>1)
    OR (parent.group_kind='single' AND (SELECT count(*) FROM lab_work_members WHERE intent_id=NEW.intent_id AND retired_revision IS NULL)>1)
    OR (parent.group_kind='single' AND EXISTS (
      SELECT 1 FROM lab_work_members a JOIN lab_work_members b ON a.intent_id=b.intent_id AND a.id<b.id
      WHERE a.intent_id=NEW.intent_id
        AND (a.retired_revision IS NULL OR b.created_revision<a.retired_revision)
        AND (b.retired_revision IS NULL OR a.created_revision<b.retired_revision)))
    THEN RAISE EXCEPTION 'lab historical member graph is invalid'; END IF;
  IF NEW.plan_item_id IS NOT NULL THEN
    SELECT p.patient_id INTO plan_patient FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE i.id=NEW.plan_item_id;
    IF plan_patient IS DISTINCT FROM NEW.patient_id THEN RAISE EXCEPTION 'lab member plan patient mismatch'; END IF;
  END IF;
  IF NEW.doctor_id IS NOT NULL THEN
    SELECT kind INTO provider_kind FROM parties WHERE id=NEW.doctor_id;
    IF provider_kind IS DISTINCT FROM 'doctor' THEN RAISE EXCEPTION 'lab member performer is not a doctor'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER lab_member_graph AFTER INSERT OR UPDATE ON lab_work_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aqlan_lab_member_graph();

CREATE FUNCTION aqlan_lab_member_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'lab member must be retired, never deleted'; END IF;
  IF ROW(NEW.id,NEW.intent_id,NEW.patient_id,NEW.service_id,NEW.source_category,NEW.tooth_code,
         NEW.quantity,NEW.plan_item_id,NEW.doctor_id,NEW.created_revision,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.intent_id,OLD.patient_id,OLD.service_id,OLD.source_category,OLD.tooth_code,
         OLD.quantity,OLD.plan_item_id,OLD.doctor_id,OLD.created_revision,OLD.created_at)
    OR OLD.retired_revision IS NOT NULL OR NEW.retired_revision IS NULL
    OR EXISTS (SELECT 1 FROM lab_work_intents WHERE id=OLD.intent_id AND (state<>'draft' OR initial_order_id IS NOT NULL))
  THEN RAISE EXCEPTION 'lab member source cannot be repurposed or resurrected'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lab_member_immutable BEFORE UPDATE OR DELETE ON lab_work_members
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_member_immutable();

CREATE FUNCTION aqlan_lab_append_only() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'lab source membership and replay receipts are append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lab_sources_append_only BEFORE UPDATE OR DELETE ON lab_prescription_source_memberships
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_append_only();
CREATE TRIGGER lab_commands_append_only BEFORE UPDATE OR DELETE ON lab_work_commands
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_append_only();

-- Deferred ownership validation allows source, order, aliases and sign timestamp
-- to be inserted in the same transaction while refusing cross-patient identities.
CREATE FUNCTION aqlan_lab_intent_patient() RETURNS TRIGGER AS $$
DECLARE expected_patient INTEGER; order_intent UUID;
BEGIN
  IF NEW.origin_kind='visit' THEN SELECT patient_id INTO expected_patient FROM visits WHERE id=NEW.origin_visit_id;
  ELSE SELECT patient_id INTO expected_patient FROM invoices WHERE id=NEW.origin_invoice_id; END IF;
  IF expected_patient IS DISTINCT FROM NEW.patient_id THEN RAISE EXCEPTION 'lab origin patient mismatch'; END IF;
  IF NEW.initial_order_id IS NOT NULL THEN
    SELECT patient_id,lab_work_intent_id INTO expected_patient,order_intent FROM lab_orders WHERE id=NEW.initial_order_id;
    IF expected_patient IS DISTINCT FROM NEW.patient_id OR order_intent IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'lab order identity/patient mismatch'; END IF;
  END IF;
  IF NEW.initial_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM lab_work_members WHERE intent_id=NEW.id AND retired_revision IS NULL
  ) THEN RAISE EXCEPTION 'materialized lab identity requires active members'; END IF;
  IF EXISTS (SELECT 1 FROM lab_work_members m WHERE m.intent_id=NEW.id AND
    (m.patient_id<>NEW.patient_id OR m.created_revision>(SELECT revision FROM lab_work_intents WHERE id=NEW.id) OR m.retired_revision>(SELECT revision FROM lab_work_intents WHERE id=NEW.id)))
    THEN RAISE EXCEPTION 'lab identity revision graph is invalid'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER lab_intent_patient AFTER INSERT OR UPDATE ON lab_work_intents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aqlan_lab_intent_patient();

CREATE FUNCTION aqlan_lab_source_live_scope() RETURNS TRIGGER AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('lab-intent'),hashtext(NEW.intent_id::text)) THEN
    RAISE EXCEPTION 'lab identity is busy; retry the complete transaction' USING ERRCODE='55P03';
  END IF;
  -- Same intent fence as member creation/retirement: no live alias can race a
  -- retirement and be admitted from a stale active-member observation.
  PERFORM 1 FROM lab_work_intents WHERE id=NEW.intent_id FOR UPDATE;
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM lab_work_members WHERE id=NEW.member_id AND retired_revision IS NOT NULL)
      THEN RAISE EXCEPTION 'retired lab member cannot gain source aliases'; END IF;
  ELSIF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'lab historical alias requires READ COMMITTED identity admission';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
CREATE TRIGGER lab_source_live_scope BEFORE INSERT ON lab_prescription_source_memberships
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_source_live_scope();

-- Exact original source proof: no financial amendment is authority to replace
-- clinical service, category, quantity or tooth. Unsupported replacements refuse.
CREATE FUNCTION aqlan_lab_source_patient() RETURNS TRIGGER AS $$
DECLARE m lab_work_members%ROWTYPE; pi plan_items%ROWTYPE;
  vp visit_procedures%ROWTYPE; item invoice_items%ROWTYPE; prior_item invoice_items%ROWTYPE;
  correction invoice_corrections%ROWTYPE; edge invoice_correction_lines%ROWTYPE;
  actual_patient INTEGER; signed_time TIMESTAMPTZ; seen INTEGER[] := ARRAY[]::INTEGER[];
BEGIN
  SELECT * INTO STRICT m FROM lab_work_members WHERE id=NEW.member_id;
  IF NOT EXISTS (SELECT 1 FROM lab_work_intents WHERE id=NEW.intent_id AND patient_id=NEW.patient_id)
    THEN RAISE EXCEPTION 'lab source parent is absent'; END IF;
  IF m.plan_item_id IS NOT NULL THEN
    SELECT * INTO STRICT pi FROM plan_items WHERE id=m.plan_item_id;
    IF NOT EXISTS (SELECT 1 FROM treatment_plans WHERE id=pi.plan_id AND patient_id=m.patient_id)
      THEN RAISE EXCEPTION 'lab plan source patient mismatch'; END IF;
    IF (pi.service_id,pi.tooth_code,pi.quantity,pi.category) IS DISTINCT FROM
       (m.service_id,m.tooth_code,m.quantity,m.source_category)
      THEN RAISE EXCEPTION 'lab immutable plan geometry mismatch'; END IF;
  END IF;
  IF m.plan_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM lab_prescription_source_memberships a WHERE a.plan_item_id=m.plan_item_id
      AND a.member_id=m.id AND a.intent_id=m.intent_id AND a.patient_id=m.patient_id
  ) THEN RAISE EXCEPTION 'lab source requires its canonical exact plan alias'; END IF;
  IF NEW.plan_item_id IS NOT NULL THEN
    IF NEW.plan_item_id IS DISTINCT FROM m.plan_item_id
      THEN RAISE EXCEPTION 'lab plan alias does not name its immutable member source'; END IF;
    RETURN NEW;
  END IF;
  IF m.retired_revision IS NOT NULL THEN RAISE EXCEPTION 'retired lab member cannot own materialized source aliases'; END IF;
  IF NEW.invoice_item_id IS NOT NULL THEN
    SELECT * INTO STRICT item FROM invoice_items WHERE id=NEW.invoice_item_id;
    LOOP
      IF item.id=ANY(seen) OR cardinality(seen)>=128 THEN RAISE EXCEPTION 'lab invoice lineage cycle or depth exceeded'; END IF;
      seen:=array_append(seen,item.id);
      SELECT patient_id INTO actual_patient FROM invoices WHERE id=item.invoice_id;
      IF actual_patient IS DISTINCT FROM m.patient_id THEN RAISE EXCEPTION 'lab invoice patient mismatch'; END IF;
      SELECT * INTO edge FROM invoice_correction_lines WHERE corrected_item_id=item.id;
      EXIT WHEN NOT FOUND;
      IF edge.original_item_id IS NULL THEN RAISE EXCEPTION 'lab invoice lineage has no original item'; END IF;
      SELECT * INTO STRICT correction FROM invoice_corrections WHERE id=edge.correction_id;
      SELECT * INTO STRICT prior_item FROM invoice_items WHERE id=edge.original_item_id;
      IF (correction.patient_id,correction.original_invoice_id,correction.corrected_invoice_id)
         IS DISTINCT FROM (m.patient_id,prior_item.invoice_id,item.invoice_id)
         OR ((item.source_type IS NOT NULL OR item.source_id IS NOT NULL) AND
             (item.source_type IS NULL OR item.source_id IS NULL OR
              (item.source_type,item.source_id) IS DISTINCT FROM (prior_item.source_type,prior_item.source_id)))
         OR (prior_item.service_id,prior_item.doctor_id,prior_item.quantity,prior_item.plan_item_id)
         IS DISTINCT FROM (item.service_id,item.doctor_id,item.quantity,item.plan_item_id)
        THEN RAISE EXCEPTION 'lab invoice correction changes source identity'; END IF;
      item:=prior_item;
    END LOOP;
    IF item.plan_item_id IS NOT NULL OR item.source_type='plan_item' THEN
      IF m.plan_item_id IS NULL OR (item.plan_item_id IS NOT NULL AND item.plan_item_id<>m.plan_item_id)
         OR (item.source_type='plan_item' AND item.source_id IS DISTINCT FROM m.plan_item_id)
         OR item.service_id IS DISTINCT FROM pi.service_id OR item.quantity IS DISTINCT FROM m.quantity
         OR (pi.doctor_id IS NOT NULL AND item.doctor_id IS DISTINCT FROM pi.doctor_id)
        THEN RAISE EXCEPTION 'lab invoice requires exact original plan item geometry'; END IF;
      IF item.source_type IS NULL AND item.source_id IS NULL OR item.source_type='plan_item' THEN RETURN NEW; END IF;
      -- Both typed pointers, when present, must independently agree.
    END IF;
    IF item.source_type IS DISTINCT FROM 'visit_procedure' OR item.source_id IS NULL
      THEN RAISE EXCEPTION 'lab invoice lacks exact typed source identity'; END IF;
    SELECT * INTO STRICT vp FROM visit_procedures WHERE id=item.source_id;
    IF item.service_id IS DISTINCT FROM vp.service_id OR item.quantity IS DISTINCT FROM vp.quantity
      THEN RAISE EXCEPTION 'lab invoice procedure geometry mismatch'; END IF;
  ELSE
    SELECT * INTO STRICT vp FROM visit_procedures WHERE id=NEW.visit_procedure_id;
  END IF;
  SELECT patient_id,signed_at INTO actual_patient,signed_time FROM visits WHERE id=vp.visit_id;
  IF signed_time IS NULL OR (actual_patient,vp.lab_work_intent_id,vp.lab_work_member_id,vp.plan_item_id,vp.service_id,vp.tooth_code)
      IS DISTINCT FROM (m.patient_id,m.intent_id,m.id,m.plan_item_id,m.service_id,m.tooth_code)
     OR (m.plan_item_id IS NULL AND vp.quantity IS DISTINCT FROM m.quantity)
    THEN RAISE EXCEPTION 'lab visit alias requires exact signed member geometry and authority'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER lab_source_patient AFTER INSERT ON lab_prescription_source_memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aqlan_lab_source_patient();

-- Integration must additionally guard source deletion/correction/substitution,
-- source tuple and exact alias compatibility, group member-set revision, signed
-- source immutability and intent/order cancellation semantics inside established
-- patient -> source -> intent/member -> order lock ordering. These checks are
-- not replaced by the ownership constraints above. No cascade or legacy relink.

CREATE FUNCTION aqlan_lab_order_intent_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.lab_work_intent_id IS DISTINCT FROM OLD.lab_work_intent_id THEN
    RAISE EXCEPTION 'lab order work identity cannot be assigned or changed retrospectively';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lab_order_intent_immutable BEFORE UPDATE ON lab_orders
  FOR EACH ROW EXECUTE FUNCTION aqlan_lab_order_intent_immutable();

CREATE FUNCTION aqlan_lab_order_graph() RETURNS TRIGGER AS $$
DECLARE parent lab_work_intents%ROWTYPE; provider_kind TEXT;
BEGIN
  IF NEW.lab_work_intent_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO parent FROM lab_work_intents WHERE id=NEW.lab_work_intent_id;
  IF NOT FOUND OR parent.initial_order_id IS DISTINCT FROM NEW.id OR parent.patient_id<>NEW.patient_id
    THEN RAISE EXCEPTION 'lab order reciprocal identity is invalid'; END IF;
  IF NEW.party_id IS NOT NULL THEN
    SELECT kind INTO provider_kind FROM parties WHERE id=NEW.party_id;
    IF provider_kind IS DISTINCT FROM 'lab' THEN RAISE EXCEPTION 'lab order provider is not a laboratory'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER lab_order_graph AFTER INSERT OR UPDATE ON lab_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aqlan_lab_order_graph();

-- Durable source identity and terminal receipts cannot be erased by reset SQL.
-- Only READ COMMITTED plus a VOLATILE check can observe commits completed
-- while TRUNCATE waited for ACCESS EXCLUSIVE. Stable snapshots must fail closed.
CREATE FUNCTION aqlan_lab_history_no_truncate() RETURNS TRIGGER AS $$
DECLARE has_rows BOOLEAN;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'lab history reset requires READ COMMITTED isolation';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)',TG_TABLE_SCHEMA,TG_TABLE_NAME) INTO has_rows;
  IF has_rows THEN RAISE EXCEPTION 'lab identity and terminal history cannot be truncated'; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql VOLATILE;
CREATE TRIGGER lab_intents_no_truncate BEFORE TRUNCATE ON lab_work_intents
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_lab_history_no_truncate();
CREATE TRIGGER lab_members_no_truncate BEFORE TRUNCATE ON lab_work_members
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_lab_history_no_truncate();
CREATE TRIGGER lab_sources_no_truncate BEFORE TRUNCATE ON lab_prescription_source_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_lab_history_no_truncate();
CREATE TRIGGER lab_commands_no_truncate BEFORE TRUNCATE ON lab_work_commands
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_lab_history_no_truncate();

-- Read-only capability checks require this exact marker, installed last and in
-- the SAME migration transaction as every table/constraint above.
CREATE TABLE lab_work_intent_schema (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  version INTEGER NOT NULL CHECK (version=1)
);
INSERT INTO lab_work_intent_schema(singleton,version) VALUES (TRUE,1);
