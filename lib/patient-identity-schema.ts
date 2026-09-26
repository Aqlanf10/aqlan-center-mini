/**
 * (PAT-3) هوية المريض وتواصله — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0028_patient_identity.sql`
 * حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * - `patients.email` و`patients.preferred_channel`: بريد المريض وقناته المفضّلة.
 * - `patients.photo_document_id`: صورة المريض = مستندٌ من مستنداته (لا تخزينٌ ثانٍ للصور).
 * - `patients.flags`: أعلامه الظاهرة في كل شاشة، من قائمة الإعداد `patients.flags`.
 * - `patient_contact_consents`: كل منحٍ أو سحبٍ لموافقة التواصل بقناته ومصدره ووقته ومن سجّله —
 *   سجلٌّ لا يُعدَّل؛ ودمج الملف المكرر وحده ينقله إلى الملف الأصلي.
 */
export const PATIENT_IDENTITY_SQL = `ALTER TABLE patients ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS preferred_channel TEXT
  CHECK (preferred_channel IS NULL OR preferred_channel IN ('whatsapp', 'sms', 'email', 'call'));
ALTER TABLE patients ADD COLUMN IF NOT EXISTS photo_document_id INTEGER REFERENCES patient_documents(id) ON DELETE SET NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS flags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS patients_flags_idx ON patients USING GIN (flags);

CREATE TABLE IF NOT EXISTS patient_contact_consents (
  id          SERIAL      PRIMARY KEY,
  patient_id  INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  channel     TEXT        NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  granted     BOOLEAN     NOT NULL,
  source      TEXT        NOT NULL CHECK (source IN ('in_person', 'phone', 'written', 'portal', 'inbound_stop')),
  note        TEXT,
  recorded_by TEXT        NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS patient_contact_consents_patient_idx ON patient_contact_consents (patient_id, channel, id DESC);

CREATE OR REPLACE FUNCTION aqlan_contact_consents_append_only() RETURNS trigger AS $$
BEGIN
  -- حذف المريض نفسه (التتالي) يُسقط سجله معه.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM patients WHERE id = OLD.patient_id) THEN
    RETURN OLD;
  END IF;
  -- دمج الملف المكرر ينقل القيد إلى الملف الأصلي: تغيير المريض وحده، لا حقلٌ غيره.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'patient_id') = (to_jsonb(OLD) - 'patient_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'سجل موافقات التواصل لا يُعدَّل ولا يُحذف — التغيير قيدٌ جديد.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS patient_contact_consents_append_only ON patient_contact_consents;
CREATE TRIGGER patient_contact_consents_append_only BEFORE UPDATE OR DELETE ON patient_contact_consents
  FOR EACH ROW EXECUTE FUNCTION aqlan_contact_consents_append_only();`;
