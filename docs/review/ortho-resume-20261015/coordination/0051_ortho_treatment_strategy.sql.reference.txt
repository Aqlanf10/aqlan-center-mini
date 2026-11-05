-- Case-scoped clinical strategy revisions. Additive only; no inferred findings or financial writes.
-- Body is byte-identical to ORTHO_TREATMENT_STRATEGY_SQL.
CREATE TABLE IF NOT EXISTS ortho_strategy_revisions (
  id                       SERIAL PRIMARY KEY,
  patient_id               INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id      INTEGER NOT NULL CHECK (recorded_patient_id > 0),
  ortho_case_id             INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id          INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  schema_version           SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  version                  INTEGER NOT NULL CHECK (version > 0),
  supersedes_revision_id   INTEGER,
  actor_user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by               TEXT NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason                   TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  recording_context        TEXT NOT NULL CHECK (recording_context IN ('current', 'retrospective')),
  command_id               TEXT NOT NULL CHECK (command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
  request_fingerprint      TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  rows                     JSONB NOT NULL CHECK (jsonb_typeof(rows) = 'array'
                              AND jsonb_array_length(rows) BETWEEN 1 AND 30
                              AND octet_length(rows::text) <= 1048576),
  CONSTRAINT ortho_strategy_case_version_unique UNIQUE (ortho_case_id, version),
  CONSTRAINT ortho_strategy_case_identity_unique UNIQUE (ortho_case_id, id),
  CONSTRAINT ortho_strategy_command_unique UNIQUE (ortho_case_id, actor_user_id, command_id),
  CONSTRAINT ortho_strategy_successor_unique UNIQUE (supersedes_revision_id),
  CONSTRAINT ortho_strategy_first_revision CHECK ((version = 1) = (supersedes_revision_id IS NULL)),
  CONSTRAINT ortho_strategy_not_self CHECK (supersedes_revision_id IS NULL OR supersedes_revision_id <> id),
  CONSTRAINT ortho_strategy_same_case_predecessor FOREIGN KEY (ortho_case_id, supersedes_revision_id)
    REFERENCES ortho_strategy_revisions(ortho_case_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS ortho_strategy_patient_case_version_idx
  ON ortho_strategy_revisions(patient_id, ortho_case_id, version DESC);

CREATE OR REPLACE FUNCTION reject_ortho_strategy_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Same ownership-only exception as medical history; never edit clinical facts,
  -- recorded provenance, command identity, revision lineage or fixed case IDs.
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'patient_id') = (to_jsonb(OLD) - 'patient_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Orthodontic strategy revisions are append-only'
    USING ERRCODE = '55000';
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'ortho_strategy_revisions'::regclass
      AND tgname = 'ortho_strategy_revision_immutable' AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER ortho_strategy_revision_immutable
      BEFORE UPDATE OR DELETE ON ortho_strategy_revisions
      FOR EACH ROW EXECUTE FUNCTION reject_ortho_strategy_revision_mutation();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION check_ortho_strategy_revision_final_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision ortho_strategy_revisions%ROWTYPE;
  predecessor ortho_strategy_revisions%ROWTYPE;
BEGIN
  -- Read final row ownership: canonical merge may update several FKs in a
  -- different order, and backup may insert the successor before its predecessor.
  SELECT * INTO current_revision FROM ortho_strategy_revisions WHERE id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Strategy revision missing at final validation' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.ortho_case_id = o.id
    WHERE o.id = current_revision.ortho_case_id AND c.id = current_revision.clinical_case_id
      AND o.patient_id = current_revision.patient_id AND c.patient_id = current_revision.patient_id
  ) THEN
    RAISE EXCEPTION 'Strategy revision current owner does not match both cases' USING ERRCODE = '23514';
  END IF;
  IF current_revision.supersedes_revision_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM ortho_strategy_revisions
      WHERE id = current_revision.supersedes_revision_id;
    IF NOT FOUND OR predecessor.ortho_case_id <> current_revision.ortho_case_id
       OR predecessor.clinical_case_id <> current_revision.clinical_case_id
       OR predecessor.version <> current_revision.version - 1 THEN
      RAISE EXCEPTION 'Strategy revision predecessor must be the exact prior version of this case'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'ortho_strategy_revisions'::regclass
      AND tgname = 'ortho_strategy_revision_final_state' AND NOT tgisinternal
  ) THEN
    CREATE CONSTRAINT TRIGGER ortho_strategy_revision_final_state
      AFTER INSERT OR UPDATE ON ortho_strategy_revisions DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION check_ortho_strategy_revision_final_state();
  END IF;
END;
$$;
