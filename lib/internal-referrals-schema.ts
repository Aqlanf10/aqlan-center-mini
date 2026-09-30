/**
 * (REF-1) الإحالة الداخلية — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0033_internal_referrals.sql`
 * حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا. إضافيٌّ خالص (docs/INTERNAL_REFERRAL_WORKFLOW.md):
 *
 * - `patient_referrals` يمتدّ ولا يُستبدل: `kind` (خارجية افتراضًا — كل صفٍّ قائم يبقى كما هو)،
 *   والطبيب المستقبِل، و«حالة سير العمل» التفصيلية للداخلية، وروابط الحالة التخصصية وبند الخطة،
 *   وخلاصة الإكمال التي تعود إلى المحيل.
 * - `status` القديم لا يُعاد تعريفه: قيدٌ في القاعدة يربط كل حالة سير عملٍ بحالتها القديمة
 *   (المفتوحة ⇒ sent، المكتملة/المُعادة ⇒ completed، المرفوضة/الملغاة ⇒ cancelled).
 * - `appointments.referral_id`: «حجز الإحالة» يربط الموعد بإحالته.
 */
export const INTERNAL_REFERRALS_SQL = `ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'external';
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS to_party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS workflow_state TEXT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS case_id INTEGER REFERENCES clinical_cases(id) ON DELETE RESTRICT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS blocks_case_id INTEGER REFERENCES clinical_cases(id) ON DELETE RESTRICT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS plan_item_id INTEGER REFERENCES plan_items(id) ON DELETE SET NULL;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS return_to_party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS accepted_by TEXT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS completed_by TEXT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS procedure_performed TEXT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS followup_required BOOLEAN;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS may_return BOOLEAN;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS referral_id INTEGER REFERENCES patient_referrals(id) ON DELETE RESTRICT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_referrals_kind_check') THEN
    ALTER TABLE patient_referrals ADD CONSTRAINT patient_referrals_kind_check CHECK (kind IN ('external', 'internal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_referrals_internal_receiver_check') THEN
    ALTER TABLE patient_referrals ADD CONSTRAINT patient_referrals_internal_receiver_check
      CHECK (kind <> 'internal' OR (to_party_id IS NOT NULL AND workflow_state IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_referrals_workflow_state_check') THEN
    ALTER TABLE patient_referrals ADD CONSTRAINT patient_referrals_workflow_state_check CHECK (
      workflow_state IS NULL
      OR (workflow_state IN ('requested', 'accepted', 'scheduled', 'arrived', 'in_progress') AND status = 'sent')
      OR (workflow_state IN ('completed', 'returned_to_referrer') AND status = 'completed')
      OR (workflow_state IN ('declined', 'cancelled') AND status = 'cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_referrals_external_state_check') THEN
    ALTER TABLE patient_referrals ADD CONSTRAINT patient_referrals_external_state_check
      CHECK (kind = 'internal' OR workflow_state IS NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS patient_referrals_internal_open_idx
  ON patient_referrals (to_party_id, created_at) WHERE kind = 'internal' AND status = 'sent';
CREATE INDEX IF NOT EXISTS patient_referrals_returned_idx
  ON patient_referrals (doctor_party_id) WHERE kind = 'internal' AND workflow_state = 'completed';
CREATE INDEX IF NOT EXISTS appointments_referral_idx ON appointments (referral_id) WHERE referral_id IS NOT NULL;`;
