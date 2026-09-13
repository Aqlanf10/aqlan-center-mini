-- (المرحلة ٢أ) دورة حياة الموعد — أختام الحالة وسجلّ الانتقالات.
--
-- ملفٌّ جديد لا تعديلٌ على خطّ الأساس: 0001 لقطةٌ مُجمَّدة شُحنت وطُبّقت على قواعد
-- قائمة، وإعادةُ كتابتها تعني أنّ ما طُبّق ليس ما هو مكتوب. والإضافة هنا محضة:
-- كل جملةٍ `IF NOT EXISTS`، فتمرّ على قاعدةٍ بنَتها `ensureSchema` أصلًا وعلى قاعدةٍ
-- تُبنى من الهجرات وحدها — وهذا الثاني هو مسار الاستعادة المعزولة.
--
-- وبلا هذا الملفّ تسقط الاستعادة فعلًا: الهدف يُبنى من الهجرات ثم تُطبَّق عليه بيانات
-- تحمل الأعمدة الجديدة، فيقول «column started_at does not exist». وقد سقطت.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

CREATE TABLE IF NOT EXISTS appointment_status_log (
  id             BIGSERIAL PRIMARY KEY,
  appointment_id INTEGER     NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  from_status    TEXT        NOT NULL,
  to_status      TEXT        NOT NULL,
  reason         TEXT,
  actor          TEXT        NOT NULL,
  actor_role     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS appointment_status_log_appointment_idx
  ON appointment_status_log (appointment_id, id);
