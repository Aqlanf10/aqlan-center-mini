/**
 * (PAT-4) العائلات والضامن — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0037_patient_families.sql`
 * حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا. إضافيٌّ خالص: جدولٌ جديد وعمودان قابلان
 * للفراغ على `patients`، لا حذف ولا إعادة تسمية ولا تعبئة لصفٍّ قائم.
 *
 * - `patient_families`: اسم العائلة (مثل «عائلة الحكيمي») وضامنٌ اختياري — مريضٌ مسجّل
 *   (`guarantor_patient_id`) **أو** شخصٌ من خارج المرضى (`guarantor_name`/`guarantor_phone`)،
 *   لا الاثنان معًا (قيد في القاعدة).
 * - `patients.family_id` / `patients.family_role`: عضوية المريض وصلته (رموزٌ تسمياتها العربية في
 *   `lib/patient-families.ts`؛ القاعدة تفرض شكل الرمز لا قائمته كي تُضاف صلةٌ بلا هجرة).
 *
 * **معلومةٌ وكشفٌ فقط — لا مال هنا** (قرار المالك): لا عمود مالي، ولا سند عائلي، ولا توزيع
 * على الأفراد. دفتر كل مريض ودفعاته وديونه كما هي. حذف المريض الضامن يفرّغ الضامن (SET NULL)،
 * وحذف العائلة (لا يحدث من الواجهة) يفرّغ عضوية أفرادها.
 */
export const PATIENT_FAMILIES_SQL = `CREATE TABLE IF NOT EXISTS patient_families (
  id                   SERIAL      PRIMARY KEY,
  name                 TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  guarantor_patient_id INTEGER     REFERENCES patients(id) ON DELETE SET NULL,
  guarantor_name       TEXT,
  guarantor_phone      TEXT,
  note                 TEXT,
  created_by           TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT patient_families_one_guarantor_check
    CHECK (guarantor_patient_id IS NULL OR (guarantor_name IS NULL AND guarantor_phone IS NULL)),
  CONSTRAINT patient_families_external_guarantor_check
    CHECK (guarantor_phone IS NULL OR guarantor_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS patient_families_guarantor_idx
  ON patient_families (guarantor_patient_id) WHERE guarantor_patient_id IS NOT NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS family_id INTEGER REFERENCES patient_families(id) ON DELETE SET NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS family_role TEXT
  CHECK (family_role IS NULL OR family_role ~ '^[a-z_]{1,20}$');
CREATE INDEX IF NOT EXISTS patients_family_idx ON patients (family_id) WHERE family_id IS NOT NULL;
`;
