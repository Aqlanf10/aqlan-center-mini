-- (HR-INT) سلامة المسير والصرف: لقطة شروط الأجر وأسباب الحجب، التزام العمولة المستقل، أجزاء الصرف، بصمة الطلب، العكس.
-- إضافية خالصة فوق 0049 (لا تعديل لهجرةٍ مطبّقة). 0050 محجوزة ومعتمدة من dot لإصلاح تكامل الموارد البشرية ضمن PR #308 بعد فحص الفروع المفتوحة.
-- اعتماد الرقم في الشفرة فقط؛ لا يُفترض عدم التطبيق اليدوي لـ0048/0049 في قواعد خارجية.
-- Body must remain byte-for-byte equal to HR_PAYROLL_INTEGRITY_SQL after these comments.
ALTER TABLE hr_payroll_items ADD COLUMN IF NOT EXISTS commission_payable_id INTEGER REFERENCES payables(id) ON DELETE SET NULL;
ALTER TABLE hr_payroll_items ADD COLUMN IF NOT EXISTS pay_terms_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE hr_payroll_items ADD COLUMN IF NOT EXISTS blocker_codes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE hr_payroll_items ADD COLUMN IF NOT EXISTS commission_basis_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS hr_payroll_items_comm_payable_idx ON hr_payroll_items (commission_payable_id) WHERE commission_payable_id IS NOT NULL;

ALTER TABLE hr_payroll_disbursements ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
ALTER TABLE hr_payroll_disbursements ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE hr_payroll_disbursements ADD COLUMN IF NOT EXISTS reversed_by TEXT;
ALTER TABLE hr_payroll_disbursements ADD COLUMN IF NOT EXISTS reversal_reason TEXT CHECK (reversal_reason IS NULL OR length(btrim(reversal_reason)) BETWEEN 2 AND 500);

CREATE TABLE IF NOT EXISTS hr_payroll_disbursement_parts (
  id               SERIAL      PRIMARY KEY,
  disbursement_id  INTEGER     NOT NULL REFERENCES hr_payroll_disbursements(id) ON DELETE CASCADE,
  component        TEXT        NOT NULL CHECK (component IN ('salary', 'commission')),
  amount_minor     BIGINT      NOT NULL CHECK (amount_minor > 0),
  expense_id       INTEGER     NOT NULL REFERENCES expenses(id),
  payable_id       INTEGER     REFERENCES payables(id) ON DELETE SET NULL,
  UNIQUE (disbursement_id, component)
);
CREATE INDEX IF NOT EXISTS hr_payroll_disb_parts_expense_idx ON hr_payroll_disbursement_parts (expense_id);
