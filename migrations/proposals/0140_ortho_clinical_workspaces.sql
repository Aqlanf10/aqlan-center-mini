-- Proposal 0140: Normalized Case-Scoped Orthodontic Clinical Workspaces & Append-Only Revision History
-- Eliminates patient-level settings JSON blob mixing across multiple ortho cases (TD-04) and supports
-- parent_document_id lineage on derived clinical images (TD-07). Zero runtime DDL in API routes.

CREATE TABLE IF NOT EXISTS ortho_clinical_workspaces (
  id BIGSERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  ortho_case_id INTEGER REFERENCES ortho_cases(id) ON DELETE SET NULL,
  scope_key TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  dentition_stage TEXT NOT NULL DEFAULT 'permanent' CHECK (dentition_stage IN ('primary', 'mixed', 'permanent')),
  questionnaire JSONB NOT NULL DEFAULT '{}'::jsonb,
  clinical_exam JSONB NOT NULL DEFAULT '{}'::jsonb,
  facial_photo JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_3d JSONB NOT NULL DEFAULT '{}'::jsonb,
  cbct JSONB NOT NULL DEFAULT '{}'::jsonb,
  cast_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_analyses JSONB NOT NULL DEFAULT '[]'::jsonb,
  problems JSONB NOT NULL DEFAULT '[]'::jsonb,
  diagnosis_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  treatment_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  retention JSONB NOT NULL DEFAULT '{}'::jsonb,
  presentation JSONB NOT NULL DEFAULT '{}'::jsonb,
  orthocore_case JSONB,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (patient_id, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_ortho_clinical_workspaces_patient_case
  ON ortho_clinical_workspaces (patient_id, ortho_case_id);

CREATE TABLE IF NOT EXISTS ortho_clinical_workspace_revisions (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES ortho_clinical_workspaces(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL,
  ortho_case_id INTEGER,
  revision INTEGER NOT NULL,
  command_type TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  reason TEXT,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, revision)
);

ALTER TABLE patient_documents
  ADD COLUMN IF NOT EXISTS parent_document_id INTEGER REFERENCES patient_documents(id) ON DELETE SET NULL;
