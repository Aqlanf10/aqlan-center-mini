-- (HR-1) ملفات الطاقم: كيان مستقل عن حساب الدخول — مسمًى وظيفيًّا حرًّا لا يمنح صلاحية،
-- نوع تعاقد (نسبة/راتب/راتب ونسبة) ومبلغ راتب بعملته ودوريته وتاريخ سريانه، وربط اختياري
-- فريد بحسابٍ موجود. سجل تغييرات append-only. إضافيٌّ خالص: جدولان جديدان.
-- 0044 محجوز لـ 0044_invoice_admin_discount_lines.sql (PR #301) — سلسلة الفواتير المتفق عليها
-- 0041–0044، وهذه المرحلة تلتقط 0045 بعد آخر هجرة منشورة في الفروع المفتوحة.
-- Body must remain byte-for-byte equal to HR_STAFF_SQL after these comments.
CREATE TABLE IF NOT EXISTS hr_staff (
  id                   SERIAL      PRIMARY KEY,
  full_name            TEXT        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 120),
  job_title            TEXT        NOT NULL DEFAULT '' CHECK (length(btrim(job_title)) <= 80),
  department           TEXT        NOT NULL DEFAULT 'other'
    CHECK (department IN ('doctors','assistants','secretariat','nursing','guard','coordinator','accounting','other')),
  work_status          TEXT        NOT NULL DEFAULT 'active'
    CHECK (work_status IN ('active','suspended','ended')),
  hire_date            DATE,
  end_date             DATE,
  -- نوع التعاقد: نسبة (من مصدر عمولات الجهات الحالي) | راتب | راتب ونسبة
  contract_kind        TEXT        NOT NULL DEFAULT 'commission'
    CHECK (contract_kind IN ('commission','salary','salary_commission')),
  -- مبلغ الراتب: بعملته ودوريته وتاريخ سريانه — ثلاثتها معًا أو لا شيء
  salary_amount_minor  BIGINT      CHECK (salary_amount_minor IS NULL OR salary_amount_minor > 0),
  -- العملة مقيدة على العملات المعتمدة للمركز (lib/money.ts) لا أي رمز ISO من ثلاثة أحرف
  salary_currency      TEXT        CHECK (salary_currency IS NULL OR salary_currency IN ('YER','SAR','USD')),
  salary_period        TEXT        CHECK (salary_period IS NULL OR salary_period IN ('monthly','weekly','daily','per_shift')),
  salary_effective_on  DATE,
  -- الربط الاختياري الفريد بحسابٍ موجود — يُنشأ يدويًّا من شاشة المستخدمين لا من هنا
  user_id              INTEGER     UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  user_linked_at       TIMESTAMPTZ,
  phone                TEXT        CHECK (phone IS NULL OR length(btrim(phone)) <= 40),
  note                 TEXT        CHECK (note IS NULL OR length(note) <= 2000),
  created_by           TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date IS NULL OR hire_date IS NULL OR end_date >= hire_date),
  CONSTRAINT hr_staff_pay_terms_complete CHECK (
    (contract_kind = 'commission')
    OR (
      contract_kind IN ('salary','salary_commission')
      AND salary_amount_minor IS NOT NULL
      AND salary_currency IS NOT NULL
      AND salary_period IS NOT NULL
      AND salary_effective_on IS NOT NULL
    )
  ),
  CHECK (contract_kind <> 'commission' OR salary_amount_minor IS NULL)
);
CREATE INDEX IF NOT EXISTS hr_staff_department_idx ON hr_staff (department, work_status);
CREATE INDEX IF NOT EXISTS hr_staff_user_idx ON hr_staff (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_staff_changes (
  id          SERIAL      PRIMARY KEY,
  staff_id    INTEGER     NOT NULL REFERENCES hr_staff(id) ON DELETE CASCADE,
  actor       TEXT        NOT NULL,
  actor_role  TEXT,
  action      TEXT        NOT NULL CHECK (action IN ('create','update','pay_terms','link_user','unlink_user')),
  field       TEXT,
  old_value   TEXT,
  new_value   TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hr_staff_changes_staff_idx ON hr_staff_changes (staff_id, id);

CREATE OR REPLACE FUNCTION aqlan_hr_staff_changes_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'hr_staff_changes is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hr_staff_changes_append_only ON hr_staff_changes;
CREATE TRIGGER hr_staff_changes_append_only
  BEFORE UPDATE OR DELETE ON hr_staff_changes
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_staff_changes_append_only();