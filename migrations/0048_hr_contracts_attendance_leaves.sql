-- (HR-3 / HR-4) العقود الإدارية، جداول العمل، الحضور والانصراف، والإجازات والأرصدة.
-- جداول مستقلة تمامًا عن ورديات الصندوق والمالية، سجل حضور أصلي محفوظ وتصحيحات معتمدة.
-- 0048 محجوز تنسيقيًا بتوجيه dot للعقود والحضور والإجازات بعد فحص main والفروع المفتوحة.
-- Body must remain byte-for-byte equal to HR_CONTRACTS_ATTENDANCE_LEAVES_SQL after these comments.
CREATE TABLE IF NOT EXISTS hr_contracts (
  id                      SERIAL      PRIMARY KEY,
  staff_id                INTEGER     NOT NULL REFERENCES hr_staff(id) ON DELETE CASCADE,
  contract_number         TEXT        NOT NULL UNIQUE CHECK (length(btrim(contract_number)) >= 3),
  template_kind           TEXT        NOT NULL
    CHECK (template_kind IN ('doctor_percentage', 'doctor_salary', 'doctor_hybrid', 'support_staff')),
  title                   TEXT        NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 150),
  status                  TEXT        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'under_review', 'approved', 'active', 'expired', 'terminated')),
  start_date              DATE        NOT NULL,
  end_date                DATE,
  probation_end_date      DATE,
  notice_period_days      INTEGER     NOT NULL DEFAULT 30 CHECK (notice_period_days >= 0),
  terms_payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  compensation_kind       TEXT        NOT NULL
    CHECK (compensation_kind IN ('commission', 'salary', 'salary_commission')),
  base_salary_minor       BIGINT      CHECK (base_salary_minor IS NULL OR base_salary_minor > 0),
  salary_currency         TEXT        CHECK (salary_currency IS NULL OR salary_currency IN ('YER', 'SAR', 'USD')),
  salary_period           TEXT        CHECK (salary_period IS NULL OR salary_period IN ('monthly', 'weekly', 'daily', 'per_shift')),
  commission_rate_percent NUMERIC(5,2) CHECK (commission_rate_percent IS NULL OR (commission_rate_percent >= 0 AND commission_rate_percent <= 100)),
  doctor_party_id         INTEGER     REFERENCES parties(id) ON DELETE SET NULL,
  parent_contract_id      INTEGER     REFERENCES hr_contracts(id) ON DELETE SET NULL,
  version_number          INTEGER     NOT NULL DEFAULT 1 CHECK (version_number >= 1),
  addendum_reason         TEXT,
  approved_by             TEXT,
  approved_at             TIMESTAMPTZ,
  signed_at               TIMESTAMPTZ,
  signed_by_staff         BOOLEAN     NOT NULL DEFAULT FALSE,
  signed_by_center        BOOLEAN     NOT NULL DEFAULT FALSE,
  attachment_refs         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  notes                   TEXT        CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by              TEXT        NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (probation_end_date IS NULL OR probation_end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS hr_contracts_staff_idx ON hr_contracts (staff_id, status);
CREATE INDEX IF NOT EXISTS hr_contracts_expiry_idx ON hr_contracts (status, end_date) WHERE end_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS hr_contracts_parent_idx ON hr_contracts (parent_contract_id) WHERE parent_contract_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_work_schedules (
  id                   SERIAL      PRIMARY KEY,
  staff_id             INTEGER     REFERENCES hr_staff(id) ON DELETE CASCADE,
  department           TEXT        CHECK (department IS NULL OR department IN ('doctors','assistants','secretariat','nursing','guard','coordinator','accounting','other')),
  name                 TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 100),
  schedule_type        TEXT        NOT NULL DEFAULT 'morning'
    CHECK (schedule_type IN ('morning', 'evening', 'split', 'variable', 'night')),
  effective_from       DATE        NOT NULL,
  effective_to         DATE,
  working_days         JSONB       NOT NULL DEFAULT '[0,1,2,3,4,6]'::jsonb,
  shift_start_time     TEXT        NOT NULL CHECK (shift_start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  shift_end_time       TEXT        NOT NULL CHECK (shift_end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  second_shift_start   TEXT        CHECK (second_shift_start IS NULL OR second_shift_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  second_shift_end     TEXT        CHECK (second_shift_end IS NULL OR second_shift_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  grace_period_mins    INTEGER     NOT NULL DEFAULT 15 CHECK (grace_period_mins >= 0 AND grace_period_mins <= 120),
  expected_daily_hours NUMERIC(4,2) NOT NULL DEFAULT 8.00 CHECK (expected_daily_hours > 0 AND expected_daily_hours <= 24),
  crosses_midnight     BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by           TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS hr_work_schedules_staff_idx ON hr_work_schedules (staff_id, is_active);
CREATE INDEX IF NOT EXISTS hr_work_schedules_dept_idx ON hr_work_schedules (department, is_active);

CREATE TABLE IF NOT EXISTS hr_attendance_records (
  id                   SERIAL      PRIMARY KEY,
  staff_id             INTEGER     NOT NULL REFERENCES hr_staff(id) ON DELETE CASCADE,
  schedule_id          INTEGER     REFERENCES hr_work_schedules(id) ON DELETE SET NULL,
  attendance_date      DATE        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'present'
    CHECK (status IN ('present', 'late', 'early_exit', 'incomplete', 'absent', 'on_leave', 'holiday', 'rest_day')),
  check_in_raw         TIMESTAMPTZ,
  check_out_raw        TIMESTAMPTZ,
  check_in_actual      TIMESTAMPTZ,
  check_out_actual     TIMESTAMPTZ,
  work_minutes         INTEGER     NOT NULL DEFAULT 0 CHECK (work_minutes >= 0),
  late_minutes         INTEGER     NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  early_exit_minutes   INTEGER     NOT NULL DEFAULT 0 CHECK (early_exit_minutes >= 0),
  overtime_minutes     INTEGER     NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  overtime_approved    BOOLEAN     NOT NULL DEFAULT FALSE,
  overtime_approved_by TEXT,
  overtime_approved_at TIMESTAMPTZ,
  is_incomplete        BOOLEAN     NOT NULL DEFAULT FALSE,
  source               TEXT        NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'imported', 'scheduled')),
  notes                TEXT        CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by           TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (staff_id, attendance_date)
);
CREATE INDEX IF NOT EXISTS hr_attendance_date_idx ON hr_attendance_records (attendance_date, status);
CREATE INDEX IF NOT EXISTS hr_attendance_staff_date_idx ON hr_attendance_records (staff_id, attendance_date DESC);

CREATE TABLE IF NOT EXISTS hr_attendance_corrections (
  id               SERIAL      PRIMARY KEY,
  attendance_id    INTEGER     NOT NULL REFERENCES hr_attendance_records(id) ON DELETE CASCADE,
  staff_id         INTEGER     NOT NULL REFERENCES hr_staff(id) ON DELETE CASCADE,
  field_corrected  TEXT        NOT NULL
    CHECK (field_corrected IN ('check_in', 'check_out', 'status', 'overtime', 'all')),
  old_check_in     TIMESTAMPTZ,
  new_check_in     TIMESTAMPTZ,
  old_check_out    TIMESTAMPTZ,
  new_check_out    TIMESTAMPTZ,
  old_status       TEXT,
  new_status       TEXT,
  reason           TEXT        NOT NULL CHECK (length(btrim(reason)) >= 3),
  requested_by     TEXT        NOT NULL,
  approved_by      TEXT        NOT NULL,
  approved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_attendance_corrections_att_idx ON hr_attendance_corrections (attendance_id);

CREATE TABLE IF NOT EXISTS hr_leave_types (
  id                     SERIAL      PRIMARY KEY,
  code                   TEXT        NOT NULL UNIQUE
    CHECK (code IN ('annual', 'sick', 'unpaid', 'emergency', 'maternity', 'paternity', 'holiday')),
  name_ar                TEXT        NOT NULL,
  is_paid                BOOLEAN     NOT NULL DEFAULT TRUE,
  default_days_per_year  NUMERIC(5,2),
  allow_negative         BOOLEAN     NOT NULL DEFAULT FALSE,
  requires_attachment    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hr_leave_balances (
  id                     SERIAL      PRIMARY KEY,
  staff_id               INTEGER     NOT NULL REFERENCES hr_staff(id) ON DELETE CASCADE,
  leave_type_code        TEXT        NOT NULL REFERENCES hr_leave_types(code) ON DELETE CASCADE,
  year                   INTEGER     NOT NULL CHECK (year >= 2020 AND year <= 2100),
  allocated_days         NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (allocated_days >= 0),
  carried_over_days      NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (carried_over_days >= 0),
  used_days              NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (used_days >= 0),
  pending_days           NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (pending_days >= 0),
  effective_from         DATE        NOT NULL,
  effective_to           DATE        NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (staff_id, leave_type_code, year)
);
CREATE INDEX IF NOT EXISTS hr_leave_balances_staff_year_idx ON hr_leave_balances (staff_id, year);

CREATE TABLE IF NOT EXISTS hr_leave_requests (
  id                     SERIAL      PRIMARY KEY,
  staff_id               INTEGER     NOT NULL REFERENCES hr_staff(id) ON DELETE CASCADE,
  leave_type_code        TEXT        NOT NULL REFERENCES hr_leave_types(code),
  start_date             DATE        NOT NULL,
  end_date               DATE        NOT NULL,
  days_count             NUMERIC(5,2) NOT NULL CHECK (days_count > 0),
  is_partial_day         BOOLEAN     NOT NULL DEFAULT FALSE,
  partial_hours          NUMERIC(4,2) CHECK (partial_hours IS NULL OR (partial_hours > 0 AND partial_hours <= 24)),
  reason                 TEXT        NOT NULL CHECK (length(btrim(reason)) >= 2),
  status                 TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'under_review', 'approved', 'rejected', 'cancelled')),
  decision_by            TEXT,
  decision_at            TIMESTAMPTZ,
  decision_reason        TEXT,
  attachment_refs        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_by             TEXT        NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS hr_leave_requests_staff_idx ON hr_leave_requests (staff_id, status);
CREATE INDEX IF NOT EXISTS hr_leave_requests_dates_idx ON hr_leave_requests (start_date, end_date);

-- إدراج الأنواع الأساسية للإجازات في حال عدم وجودها
INSERT INTO hr_leave_types (code, name_ar, is_paid, default_days_per_year, allow_negative, requires_attachment)
VALUES
  ('annual', 'إجازة سنوية', true, NULL, false, false),
  ('sick', 'إجازة مرضية', true, NULL, false, true),
  ('unpaid', 'إجازة بدون راتب', false, NULL, true, false),
  ('emergency', 'إجازة طارئة', true, NULL, false, false),
  ('holiday', 'عطلة رسمية', true, NULL, false, false)
ON CONFLICT (code) DO NOTHING;
