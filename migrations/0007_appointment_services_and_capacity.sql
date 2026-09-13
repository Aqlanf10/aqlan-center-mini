-- (المرحلة ٤ب) كتالوج خدمات المواعيد الديناميّ ومدخلات محرّك السعة.
--
-- ملفٌّ جديد لا تعديلٌ على ما شُحن: الهجرات السابقة طُبّقت على قواعد قائمة،
-- وإعادةُ كتابتها تعني أنّ ما طُبّق ليس ما هو مكتوب. وكلُّ جملةٍ هنا `IF NOT EXISTS`
-- فتمرّ على قاعدةٍ بنَتها `ensureSchema` وعلى قاعدةٍ تُبنى من الهجرات وحدها — وهذا
-- الثاني هو مسار الاستعادة المعزولة.

-- ── خدمات المواعيد: سجلّات لا مفاتيح إعدادات ──────────────────────────────
-- «نوع الزيارة» كان مصفوفةً في الشيفرة: إضافةُ خدمةٍ جديدة تعني نشرةً برمجية.
-- وصار سجلًّا يملكه المالك. والرمز `code` هو الهوية الثابتة للتكاملات والقواعد —
-- لا الاسم العربي، لأنّ الاسم يُحرَّر والهوية لا تُحرَّر.
CREATE TABLE IF NOT EXISTS appointment_services (
  id                     SERIAL PRIMARY KEY,
  code                   TEXT        NOT NULL UNIQUE,
  name_ar                TEXT        NOT NULL,
  name_en                TEXT,
  specialty              TEXT        NOT NULL DEFAULT 'general',
  default_duration_minutes INTEGER   NOT NULL DEFAULT 20,
  buffer_before_minutes  INTEGER     NOT NULL DEFAULT 0,
  buffer_after_minutes   INTEGER     NOT NULL DEFAULT 0,
  requires_provider      BOOLEAN     NOT NULL DEFAULT TRUE,
  requires_chair         BOOLEAN     NOT NULL DEFAULT TRUE,
  allows_concurrent_provider_work BOOLEAN NOT NULL DEFAULT FALSE,
  consumes_emergency_reserve BOOLEAN NOT NULL DEFAULT FALSE,
  priority               INTEGER     NOT NULL DEFAULT 100,
  badge_class            TEXT,
  is_active              BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order             INTEGER     NOT NULL DEFAULT 100,
  -- الرمز القديم المقابل (consultation, follow_up …) — جسرُ توافقٍ مع المواعيد
  -- التاريخية، ولا يُحذف ولا يُعاد كتابته.
  legacy_type            TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by             TEXT
);
CREATE INDEX IF NOT EXISTS appointment_services_active_idx
  ON appointment_services (is_active, sort_order, id);
CREATE INDEX IF NOT EXISTS appointment_services_legacy_idx
  ON appointment_services (legacy_type);

-- ── حجب الأطباء: إجازة، اجتماع، عمليّة، تدريب ─────────────────────────────
-- لا جدول أطباء ثانٍ: المزوّد هو `parties` نفسه (kind='doctor').
CREATE TABLE IF NOT EXISTS provider_blocks (
  id           BIGSERIAL PRIMARY KEY,
  provider_id  INTEGER     NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  reason       TEXT        NOT NULL,
  -- الإلغاء حالةٌ لا حذف: «مَن ألغى حجب الطبيب ومتى» سؤالٌ يُسأل.
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   TEXT        NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_blocks_provider_idx
  ON provider_blocks (provider_id, starts_at, ends_at);

-- ── لقطات الجدولة على الموعد ───────────────────────────────────────────────
-- الموعد يحتفظ بالوقائع التي حُجز بها. تغييرُ الخدمة غدًا لا يعيد كتابة ماضٍ:
-- موعدٌ حُجز بعشر دقائق يبقى عشرًا ولو صارت الخدمة خمس عشرة.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS service_id INTEGER
  REFERENCES appointment_services(id) ON DELETE SET NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS buffer_before_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS buffer_after_minutes INTEGER NOT NULL DEFAULT 0;
-- رقم الكرسي: `NULL` تعني «لم يُخصَّص» لا «بلا كرسي» — والفرق حاسمٌ في الحساب.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS chair_no INTEGER;
CREATE INDEX IF NOT EXISTS appointments_doctor_date_idx
  ON appointments (doctor_id, scheduled_date);
CREATE INDEX IF NOT EXISTS appointments_chair_date_idx
  ON appointments (chair_no, scheduled_date);
