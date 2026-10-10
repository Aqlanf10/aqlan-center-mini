/**
 * (HR-INT) سلامة المسير والصرف — مصدرٌ واحد للمخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0050_hr_payroll_integrity.sql` حرفيًّا.
 *
 * إضافيٌّ خالص فوق 0049 (لا تعديل لهجرةٍ مطبَّقة ولا لبصمتها):
 *
 *  ١) لقطة شروط الأجر على بند المسير (`pay_terms_snapshot`): المصدر (عقد/ملف)، رقم العقد وإصداره والمبلغ والعملة والدورية
 *     يوم الاحتساب — فيبقى الاستحقاق المعتمد على ما اعتُمد عليه مهما عُدِّل العقد أو الملف بعده.
 *  ٢) `blocker_codes`: أسباب حجب البند (تعارض ملف/عقد، تغيّر الأجر أثناء الفترة، دورية غير شهرية، التحاق/انتهاء منتصف
 *     الفترة…) — سياسات التقسيم غير المحددة لا تُخمَّن، تُعلن ويُمنع الاعتماد حتى تُحسم.
 *  ٣) التزام العمولة المستقل (`commission_payable_id`، تصنيف commission) فوق التزام الراتب (`payable_id`، تصنيف salary):
 *     كل جزءٍ يُسدَّد بسند من تصنيفه، فيرى كشف الطبيب (المحرك القائم) ما سُدِّد من عمولته ولا يُصرف ثانيةً.
 *  ٤) أجزاء الصرف (`hr_payroll_disbursement_parts`): صرفٌ واحد = سند لكل جزء، بالمبلغ والتصنيف والالتزام.
 *  ٥) بصمة محتوى الطلب (`request_fingerprint`) لمطابقة مفتاح الطلب، وأعمدة العكس (`reversed_*`).
 */
export const HR_PAYROLL_INTEGRITY_SQL = `ALTER TABLE hr_payroll_items ADD COLUMN IF NOT EXISTS commission_payable_id INTEGER REFERENCES payables(id) ON DELETE SET NULL;
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
CREATE INDEX IF NOT EXISTS hr_payroll_disb_parts_expense_idx ON hr_payroll_disbursement_parts (expense_id);`;
