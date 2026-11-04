/** Exact additive runtime mirror of migration 0107. */
export const ORTHO_SPACE_SQL = `-- Append-only space planning and actual IPR documentation. No clinical or financial action.
CREATE TABLE ortho_space_entries (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK(schema_version=1),
  version INTEGER NOT NULL CHECK(version>0), predecessor_id INTEGER,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL CHECK(length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  recording_context TEXT NOT NULL CONSTRAINT ortho_journey_recording_context_check CHECK(recording_context IN ('current','retrospective')),
  case_status_at_capture TEXT NOT NULL CONSTRAINT ortho_journey_capture_status_check CHECK(case_status_at_capture IN ('assessment','active','retention','completed','discontinued')),
  command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  content JSONB NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=2097152),
  UNIQUE(ortho_case_id,version), UNIQUE(ortho_case_id,id), UNIQUE(ortho_case_id,actor_user_id,command_id), UNIQUE(predecessor_id),
  CHECK((version=1)=(predecessor_id IS NULL)), CHECK(predecessor_id IS DISTINCT FROM id),
  CONSTRAINT ortho_journey_context_status_check CHECK((recording_context='retrospective')=(case_status_at_capture IN ('completed','discontinued'))),
 arch TEXT NOT NULL CHECK(arch IN ('upper','lower')),
 entry_kind TEXT NOT NULL CHECK(entry_kind IN ('plan','ipr')),
 strategy_revision_id INTEGER REFERENCES ortho_strategy_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 assessment_revision_id INTEGER REFERENCES ortho_assessment_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 plan_entry_id INTEGER,
 adjustment_id INTEGER REFERENCES ortho_adjustments(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 supersedes_entry_id INTEGER UNIQUE,
 CHECK(arch IS NOT DISTINCT FROM content->'authored'->>'arch'),
 CHECK(entry_kind IS NOT DISTINCT FROM content->'authored'->>'kind'),
 CHECK(strategy_revision_id IS NOT DISTINCT FROM (content->'authored'->>'strategyRevisionId')::integer),
 CHECK(assessment_revision_id IS NOT DISTINCT FROM (content->'authored'->'baseline'->>'id')::integer),
 CHECK(plan_entry_id IS NOT DISTINCT FROM (content->'authored'->>'planEntryId')::integer),
 CHECK(adjustment_id IS NOT DISTINCT FROM (content->'authored'->>'adjustmentId')::integer),
 CHECK(supersedes_entry_id IS NOT DISTINCT FROM (content->'authored'->>'supersedesEntryId')::integer),
 CHECK((entry_kind='plan')=(strategy_revision_id IS NOT NULL AND assessment_revision_id IS NOT NULL)),
 CHECK((entry_kind='ipr')=(plan_entry_id IS NOT NULL AND adjustment_id IS NOT NULL)),
 CHECK(supersedes_entry_id IS NULL OR entry_kind='ipr'),
 CHECK(entry_kind<>'ipr' OR case_status_at_capture<>'assessment'),
 FOREIGN KEY(ortho_case_id,predecessor_id) REFERENCES ortho_space_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(ortho_case_id,plan_entry_id) REFERENCES ortho_space_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(ortho_case_id,supersedes_entry_id) REFERENCES ortho_space_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ortho_space_patient_case_idx ON ortho_space_entries(patient_id,ortho_case_id,version DESC);
CREATE INDEX ortho_space_adjustment_idx ON ortho_space_entries(adjustment_id);
CREATE TRIGGER ortho_space_immutable BEFORE UPDATE OR DELETE ON ortho_space_entries FOR EACH ROW EXECUTE FUNCTION reject_ortho_journey_mutation();
CREATE FUNCTION check_ortho_space_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM ortho_space_entries r
 LEFT JOIN ortho_cases o ON o.id=r.ortho_case_id LEFT JOIN clinical_cases c ON c.id=r.clinical_case_id
 LEFT JOIN ortho_space_entries previous ON previous.id=r.predecessor_id
 LEFT JOIN ortho_strategy_revisions s ON s.id=r.strategy_revision_id
 LEFT JOIN ortho_assessment_revisions a ON a.id=r.assessment_revision_id
 LEFT JOIN ortho_space_entries p ON p.id=r.plan_entry_id
 LEFT JOIN ortho_adjustments adjustment ON adjustment.id=r.adjustment_id
 LEFT JOIN visits v ON v.id=adjustment.visit_id
 LEFT JOIN ortho_space_entries corrected ON corrected.id=r.supersedes_entry_id
 WHERE ((TG_TABLE_NAME='ortho_space_entries' AND r.id=NEW.id)
 OR (TG_TABLE_NAME='ortho_cases' AND r.ortho_case_id=NEW.id)
 OR (TG_TABLE_NAME='clinical_cases' AND r.clinical_case_id=NEW.id)
 OR (TG_TABLE_NAME='ortho_strategy_revisions' AND r.strategy_revision_id=NEW.id)
 OR (TG_TABLE_NAME='ortho_assessment_revisions' AND r.assessment_revision_id=NEW.id)
 OR (TG_TABLE_NAME='ortho_adjustments' AND r.adjustment_id=NEW.id)
 OR (TG_TABLE_NAME='visits' AND adjustment.visit_id=NEW.id))
 AND (r.patient_id IS DISTINCT FROM o.patient_id OR r.patient_id IS DISTINCT FROM c.patient_id OR c.ortho_case_id IS DISTINCT FROM r.ortho_case_id
 OR (r.predecessor_id IS NOT NULL AND (previous.version IS DISTINCT FROM r.version-1 OR previous.clinical_case_id IS DISTINCT FROM r.clinical_case_id))
 OR (r.entry_kind='plan' AND (s.patient_id IS DISTINCT FROM r.patient_id OR s.ortho_case_id IS DISTINCT FROM r.ortho_case_id OR s.clinical_case_id IS DISTINCT FROM r.clinical_case_id
   OR a.patient_id IS DISTINCT FROM r.patient_id OR a.ortho_case_id IS DISTINCT FROM r.ortho_case_id OR a.clinical_case_id IS DISTINCT FROM r.clinical_case_id))
 OR (r.entry_kind='ipr' AND (p.entry_kind IS DISTINCT FROM 'plan' OR p.arch IS DISTINCT FROM r.arch OR p.version>=r.version
   OR adjustment.case_id IS DISTINCT FROM r.ortho_case_id OR adjustment.visit_id IS NULL OR v.patient_id IS DISTINCT FROM r.patient_id OR (v.case_id IS NOT NULL AND v.case_id<>r.clinical_case_id)))
 OR (r.supersedes_entry_id IS NOT NULL AND (corrected.entry_kind IS DISTINCT FROM 'ipr' OR corrected.version>=r.version
   OR corrected.plan_entry_id IS DISTINCT FROM r.plan_entry_id OR corrected.adjustment_id IS DISTINCT FROM r.adjustment_id
   OR corrected.arch IS DISTINCT FROM r.arch OR corrected.content->'authored'->'teeth' IS DISTINCT FROM r.content->'authored'->'teeth')))) THEN
 RAISE EXCEPTION 'Orthodontic space ownership or lineage changed' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER ortho_space_scope_ortho_space_entries AFTER INSERT OR UPDATE ON ortho_space_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_space_scope();
CREATE CONSTRAINT TRIGGER ortho_space_scope_ortho_cases AFTER UPDATE ON ortho_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_space_scope();
CREATE CONSTRAINT TRIGGER ortho_space_scope_clinical_cases AFTER UPDATE ON clinical_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_space_scope();
CREATE CONSTRAINT TRIGGER ortho_space_scope_ortho_strategy_revisions AFTER UPDATE ON ortho_strategy_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_space_scope();
CREATE CONSTRAINT TRIGGER ortho_space_scope_ortho_assessment_revisions AFTER UPDATE ON ortho_assessment_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_space_scope();
CREATE CONSTRAINT TRIGGER ortho_space_scope_ortho_adjustments AFTER UPDATE ON ortho_adjustments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_space_scope();
CREATE CONSTRAINT TRIGGER ortho_space_scope_visits AFTER UPDATE ON visits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_space_scope();
`;
