/**
 * (HR-5 / HR-6) المستحقات، مسير الرواتب، وسندات الصرف — مصدر واحد للمخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0049_hr_payroll_disbursements.sql` حرفيًّا.
 *
 * قواعد الدستور والنظام:
 * ١) عزل العملات التام: كل مسير وكل بند وكل صرف بعملة واحدة مستقلة ('YER', 'SAR', 'USD').
 *    لا تحويل تلقائي ولا جمع بين عملات مختلفة إطلاقًا.
 *
 * ٢) تكامل العمولات من المحرك الحالي:
 *    عمولات الأطباء تُسحب من مصدر العمولات الحالي (commissions / parties)
 *    وتُحفظ معرفاتها في commission_details لمنع احتسابها أو صرفها مرتين.
 *
 * ٣) الفصل بين الاستحقاق والصرف:
 *    اعتماد المسير ينشئ التزامًا ماليًا (payable_id في payables).
 *    الصرف النقدي ينشئ سند صرف (expense_id في expenses) يسدد ذلك الالتزام.
 *    لا تكرار لتكلفة الرواتب في القيود، ولا إنشاء لدفتر حسابات موازٍ.
 *
 * ٤) أمان التزامن وإقفال الفترات:
 *    حماية ضد السباق (concurrency)، حماية ضد التكرار (client_request_id)،
 *    ومنع الصرف الزائد عن صافي المستحق (remaining_minor >= 0).
 */
export const HR_PAYROLL_SQL = `CREATE TABLE IF NOT EXISTS hr_payroll_periods (
  id           SERIAL      PRIMARY KEY,
  period_key   TEXT        NOT NULL UNIQUE CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  name         TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 100),
  start_date   DATE        NOT NULL,
  end_date     DATE        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'calculated', 'approved', 'closed')),
  closed_at    TIMESTAMPTZ,
  closed_by    TEXT,
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS hr_payroll_periods_status_idx ON hr_payroll_periods (status, start_date DESC);

CREATE TABLE IF NOT EXISTS hr_payroll_runs (
  id                       SERIAL      PRIMARY KEY,
  period_id                INTEGER     NOT NULL REFERENCES hr_payroll_periods(id) ON DELETE CASCADE,
  currency                 TEXT        NOT NULL CHECK (currency IN ('YER', 'SAR', 'USD')),
  status                   TEXT        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'closed')),
  total_base_salary_minor  BIGINT      NOT NULL DEFAULT 0 CHECK (total_base_salary_minor >= 0),
  total_allowances_minor   BIGINT      NOT NULL DEFAULT 0 CHECK (total_allowances_minor >= 0),
  total_commissions_minor  BIGINT      NOT NULL DEFAULT 0 CHECK (total_commissions_minor >= 0),
  total_advances_minor     BIGINT      NOT NULL DEFAULT 0 CHECK (total_advances_minor >= 0),
  total_deductions_minor   BIGINT      NOT NULL DEFAULT 0 CHECK (total_deductions_minor >= 0),
  total_net_due_minor      BIGINT      NOT NULL DEFAULT 0 CHECK (total_net_due_minor >= 0),
  total_paid_minor         BIGINT      NOT NULL DEFAULT 0 CHECK (total_paid_minor >= 0),
  total_remaining_minor    BIGINT      NOT NULL DEFAULT 0 CHECK (total_remaining_minor >= 0),
  approved_by              TEXT,
  approved_at              TIMESTAMPTZ,
  created_by               TEXT        NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, currency)
);
CREATE INDEX IF NOT EXISTS hr_payroll_runs_period_idx ON hr_payroll_runs (period_id, status);

CREATE TABLE IF NOT EXISTS hr_payroll_items (
  id                   SERIAL      PRIMARY KEY,
  run_id               INTEGER     NOT NULL REFERENCES hr_payroll_runs(id) ON DELETE CASCADE,
  staff_id             INTEGER     NOT NULL REFERENCES hr_staff(id) ON DELETE CASCADE,
  currency             TEXT        NOT NULL CHECK (currency IN ('YER', 'SAR', 'USD')),
  base_salary_minor    BIGINT      NOT NULL DEFAULT 0 CHECK (base_salary_minor >= 0),
  allowances_minor     BIGINT      NOT NULL DEFAULT 0 CHECK (allowances_minor >= 0),
  allowance_details    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  commissions_minor    BIGINT      NOT NULL DEFAULT 0 CHECK (commissions_minor >= 0),
  commission_details   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  advances_minor       BIGINT      NOT NULL DEFAULT 0 CHECK (advances_minor >= 0),
  deductions_minor     BIGINT      NOT NULL DEFAULT 0 CHECK (deductions_minor >= 0),
  deduction_details    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  net_due_minor        BIGINT      NOT NULL DEFAULT 0 CHECK (net_due_minor >= 0),
  paid_minor           BIGINT      NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  remaining_minor      BIGINT      NOT NULL DEFAULT 0 CHECK (remaining_minor >= 0),
  status               TEXT        NOT NULL DEFAULT 'accrued'
    CHECK (status IN ('accrued', 'partially_paid', 'fully_paid', 'reversed')),
  payable_id           INTEGER     REFERENCES payables(id) ON DELETE SET NULL,
  notes                TEXT        CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, staff_id),
  CHECK (paid_minor <= net_due_minor),
  CHECK (remaining_minor = (net_due_minor - paid_minor))
);
CREATE INDEX IF NOT EXISTS hr_payroll_items_staff_idx ON hr_payroll_items (staff_id, status);
CREATE INDEX IF NOT EXISTS hr_payroll_items_run_idx ON hr_payroll_items (run_id, status);
CREATE INDEX IF NOT EXISTS hr_payroll_items_payable_idx ON hr_payroll_items (payable_id) WHERE payable_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_payroll_disbursements (
  id                 SERIAL      PRIMARY KEY,
  item_id            INTEGER     NOT NULL REFERENCES hr_payroll_items(id) ON DELETE CASCADE,
  staff_id           INTEGER     NOT NULL REFERENCES hr_staff(id) ON DELETE CASCADE,
  currency           TEXT        NOT NULL CHECK (currency IN ('YER', 'SAR', 'USD')),
  amount_minor       BIGINT      NOT NULL CHECK (amount_minor > 0),
  payment_method     TEXT        NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('cash', 'bank_transfer', 'cheque')),
  reference_number   TEXT        CHECK (reference_number IS NULL OR length(btrim(reference_number)) <= 100),
  expense_id         INTEGER     REFERENCES expenses(id) ON DELETE SET NULL,
  disbursed_by       TEXT        NOT NULL,
  disbursed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes              TEXT        CHECK (notes IS NULL OR length(notes) <= 1000),
  client_request_id  TEXT        UNIQUE CHECK (client_request_id IS NULL OR length(btrim(client_request_id)) BETWEEN 8 AND 100)
);
CREATE INDEX IF NOT EXISTS hr_payroll_disb_item_idx ON hr_payroll_disbursements (item_id);
CREATE INDEX IF NOT EXISTS hr_payroll_disb_staff_idx ON hr_payroll_disbursements (staff_id, disbursed_at DESC);
CREATE INDEX IF NOT EXISTS hr_payroll_disb_expense_idx ON hr_payroll_disbursements (expense_id) WHERE expense_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_settings (
  id              SERIAL      PRIMARY KEY,
  key             TEXT        NOT NULL UNIQUE CHECK (length(btrim(key)) >= 2),
  value           JSONB       NOT NULL,
  description     TEXT,
  effective_from  DATE        NOT NULL DEFAULT CURRENT_DATE,
  updated_by      TEXT        NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- إدراج السياسات المبدئية بتاريخ سريان صريح (غير مجبرة كأرقام هاردكود)
INSERT INTO hr_settings (key, value, description, effective_from, updated_by)
VALUES
  ('payroll_cycle', '{"default_currency":"YER","salary_day":28,"cutoff_day":25}'::jsonb, 'دورة الرواتب الشهرية ويوم الاستحقاق', CURRENT_DATE, 'system'),
  ('attendance_policy', '{"late_grace_mins":15,"late_deduction_rate_per_hour":1.0,"overtime_rate_multiplier":1.5}'::jsonb, 'سياسة التأخير والإضافي وسماح الحضور', CURRENT_DATE, 'system'),
  ('leave_policy', '{"annual_default_days":21,"probation_months":3}'::jsonb, 'سياسة الإجازات السنوية وفترة التجربة', CURRENT_DATE, 'system')
ON CONFLICT (key) DO NOTHING;`;
