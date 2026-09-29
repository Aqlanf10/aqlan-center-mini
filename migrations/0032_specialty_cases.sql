-- (CASE-MODEL-1) Specialty cases, problem list, plan-item links/priority/dependencies, visit case context.
-- One patient → one clinical record → many specialty cases. Additive only: new tables and nullable columns.
-- Body must remain byte-for-byte equal to SPECIALTY_CASES_SQL after these comments.
CREATE TABLE IF NOT EXISTS clinical_cases (
  id                   SERIAL      PRIMARY KEY,
  patient_id           INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  specialty            TEXT        NOT NULL CHECK (length(btrim(specialty)) > 0),
  title                TEXT        NOT NULL CHECK (length(btrim(title)) > 0),
  site                 TEXT,
  problem              TEXT,
  responsible_party_id INTEGER     REFERENCES parties(id) ON DELETE RESTRICT,
  status               TEXT        NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'waiting', 'completed', 'closed', 'cancelled')),
  started_on           DATE        NOT NULL DEFAULT CURRENT_DATE,
  completed_at         TIMESTAMPTZ,
  outcome              TEXT,
  ortho_case_id        INTEGER     UNIQUE REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  created_by           TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status IN ('completed', 'closed', 'cancelled')) = (completed_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR length(btrim(coalesce(outcome, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS clinical_cases_patient_idx ON clinical_cases (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clinical_cases_open_responsible_idx
  ON clinical_cases (responsible_party_id) WHERE status IN ('active', 'waiting');
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS case_id INTEGER REFERENCES clinical_cases(id) ON DELETE RESTRICT;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS priority SMALLINT;
CREATE INDEX IF NOT EXISTS plan_items_case_idx ON plan_items (case_id) WHERE case_id IS NOT NULL;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS case_id INTEGER REFERENCES clinical_cases(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS visits_case_idx ON visits (case_id) WHERE case_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS plan_item_dependencies (
  item_id          INTEGER     NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  requires_item_id INTEGER     NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  requirement      TEXT        NOT NULL DEFAULT 'completed' CHECK (requirement IN ('completed', 'clearance')),
  note             TEXT,
  created_by       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, requires_item_id),
  CHECK (item_id <> requires_item_id)
);
CREATE INDEX IF NOT EXISTS plan_item_dependencies_requires_idx ON plan_item_dependencies (requires_item_id);
CREATE TABLE IF NOT EXISTS patient_problems (
  id           SERIAL      PRIMARY KEY,
  patient_id   INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  label        TEXT        NOT NULL CHECK (length(btrim(label)) > 0),
  site         TEXT,
  specialty    TEXT,
  status       TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'inactive')),
  case_id      INTEGER     REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  plan_item_id INTEGER     REFERENCES plan_items(id) ON DELETE SET NULL,
  referral_id  INTEGER     REFERENCES patient_referrals(id) ON DELETE RESTRICT,
  noted_by     TEXT        NOT NULL,
  noted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by  TEXT,
  resolved_at  TIMESTAMPTZ,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS patient_problems_patient_idx ON patient_problems (patient_id, status, noted_at DESC);
