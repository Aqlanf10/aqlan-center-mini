-- (المرحلة ٥ — الإتمام) ما نصّت عليه الخطة المعتمدة ولم تُنفّذه المرحلة ٥ الأولى.
--
-- إضافيّةٌ بالكامل: لا عمودَ يُحذف، ولا صفَّ يُفقد، ولا هجرةَ مشحونة تُمسّ.

-- ── ١) الأيام المفضّلة ────────────────────────────────────────────────────
-- مصفوفةُ أرقامٍ بترقيم ISO: ١ الاثنين … ٧ الأحد. والفراغُ يعني «أيّ يوم».
-- ولا تُخزَّن أسماء الأيام العربية هويةً: العرضُ يُترجَم، والهويةُ رقمٌ ثابت.
ALTER TABLE waiting_list
  ADD COLUMN IF NOT EXISTS preferred_days SMALLINT[] NOT NULL DEFAULT '{}';

-- حارسٌ في القاعدة لا في الشيفرة وحدها: قيمٌ صالحة، وبلا تكرار.
-- (يُسقَط ثمّ يُضاف — الصيغة المتّبعة في هذا المخطّط، فالتشغيل الثاني لا يسقط.)
--
-- وفحصُ التكرار مكتوبٌ بلا استعلامٍ فرعيّ عمدًا: PostgreSQL يرفض الاستعلامات
-- الفرعية داخل CHECK («cannot use subquery in check constraint») — فصياغةٌ مثل
-- ARRAY(SELECT DISTINCT unnest(...)) تُسقط الهجرة نفسها على القاعدة الحقيقية.
-- والمجال هنا سبع قيمٍ معلومة، فعدُّ الحاضر منها مرّةً واحدة يساوي طولَ
-- المصفوفة إن — وإن فقط — لم يتكرّر فيها يوم.
ALTER TABLE waiting_list DROP CONSTRAINT IF EXISTS waiting_list_preferred_days_valid;
ALTER TABLE waiting_list ADD CONSTRAINT waiting_list_preferred_days_valid
  CHECK (
      preferred_days <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[]
      AND COALESCE(array_length(preferred_days, 1), 0) = (
        (CASE WHEN 1 = ANY(preferred_days) THEN 1 ELSE 0 END)
        + (CASE WHEN 2 = ANY(preferred_days) THEN 1 ELSE 0 END)
        + (CASE WHEN 3 = ANY(preferred_days) THEN 1 ELSE 0 END)
        + (CASE WHEN 4 = ANY(preferred_days) THEN 1 ELSE 0 END)
        + (CASE WHEN 5 = ANY(preferred_days) THEN 1 ELSE 0 END)
        + (CASE WHEN 6 = ANY(preferred_days) THEN 1 ELSE 0 END)
        + (CASE WHEN 7 = ANY(preferred_days) THEN 1 ELSE 0 END)
      )
    );

-- ── ٢) إتاحة اليوم نفسه ───────────────────────────────────────────────────
-- الافتراضيّ TRUE عمدًا: صفوف المرحلة ٥ القائمة كانت مؤهّلةً لمكانٍ اليوم فعلًا،
-- وجعلُها FALSE يسحب منها سلوكًا كانت تملكه — وهو ما نهت عنه المراجعة صراحةً.
-- والجديد تختاره الاستقبال بنفسها في النموذج، لا افتراضًا مخفيًّا.
ALTER TABLE waiting_list
  ADD COLUMN IF NOT EXISTS same_day_available BOOLEAN NOT NULL DEFAULT TRUE;

-- ── ٣) الوردية المفضّلة — من ورديات المركز المُهيّأة لا من منتصف النهار ─────
-- 'any' | 'shift1' | 'shift2' — والمرجع `loadCapacityContext().shifts`.
ALTER TABLE waiting_list
  ADD COLUMN IF NOT EXISTS preferred_shift TEXT NOT NULL DEFAULT 'any';

-- ترحيلُ التفضيل القديم مرّةً واحدة: صباحًا←الأولى، مساءً←الثانية.
-- و`preferred_period` يبقى كما هو سجلًّا تاريخيًّا — لا يُحذف ولا يُعاد كتابته.
-- ملاحظة موثَّقة: إن كان المركز يعمل ورديةً واحدة، فطلبُ «الثانية» لا يقابله شيء
-- في التهيئة؛ والمطابقة تعامله حينها **غير مقيِّد** لا «لا يطابق أبدًا» — فلا
-- يسقط مريضٌ من القائمة بسبب ورديةٍ لا يشغّلها المركز.
UPDATE waiting_list
   SET preferred_shift = CASE preferred_period
         WHEN 'morning' THEN 'shift1'
         WHEN 'evening' THEN 'shift2'
         ELSE 'any' END
 WHERE preferred_shift = 'any' AND preferred_period <> 'any';

-- ── ٣ب) مطالبةُ التحويل إلى موعد ──────────────────────────────────────────
-- «حُجز» يجب ألّا تُقال أبدًا بلا موعدٍ حقيقيّ. ولو استعملنا الحالة نفسها
-- مطالبةً (نضعها «حُجز» ثم نحجز) لتركَ انهيارٌ بين الخطوتين صفًّا يقول «حُجز»
-- ولا موعد — وهو بالضبط ما نُمنع منه.
-- فالمطالبة ختمٌ منفصل: من ينال الختم وحده يحجز، والحالة لا تتغيّر إلا **بعد**
-- أن يوجد الموعد. وختمٌ قديمٌ يسقط بنفسه بعد دقيقتين، فانهيارٌ في المنتصف
-- يتعافى وحده بلا تدخّل.
ALTER TABLE waiting_list
  ADD COLUMN IF NOT EXISTS booking_claim_at TIMESTAMPTZ;
ALTER TABLE waiting_list
  ADD COLUMN IF NOT EXISTS booking_claim_by TEXT;

-- ── ٤) سجلّ الاتصال — أحداثٌ تُضاف ولا تُكتب فوقها ────────────────────────
-- «نودي» كانت تجيب «اتّصل أحدٌ ما» ولا تجيب: أردّ؟ قبل؟ رفض هذا الموعد؟ كم
-- محاولة؟ ومن اتّصل في كلّ مرّة؟ فصار لكلّ محاولةٍ صفُّها.
CREATE TABLE IF NOT EXISTS waiting_list_contact_events (
  id               BIGSERIAL   PRIMARY KEY,
  waiting_list_id  INTEGER     NOT NULL REFERENCES waiting_list(id) ON DELETE CASCADE,
  contacted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contacted_by     TEXT        NOT NULL,
  contacted_by_role TEXT,
  channel          TEXT        NOT NULL DEFAULT 'phone',
  outcome          TEXT        NOT NULL,
  note             TEXT,
  -- المكان الذي عُرض في هذه المحاولة — فيُعرف أيُّ موعدٍ رُفض بعينه.
  slot_date        DATE,
  slot_time        TIME,
  -- الموعد الذي نتج عن المحاولة إن حُجز.
  appointment_id   INTEGER     REFERENCES appointments(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS waiting_list_contact_events_entry_idx
  ON waiting_list_contact_events (waiting_list_id, contacted_at DESC);
CREATE INDEX IF NOT EXISTS waiting_list_contact_events_slot_idx
  ON waiting_list_contact_events (waiting_list_id, slot_date, slot_time);

-- ── ٥) هوية التكرار — بالحاجة لا بالمريض ──────────────────────────────────
-- الفهرس السابق كان يمنع المريض من انتظار حاجتين مختلفتين: متابعة تقويم
-- **و** استشارة زراعة. وهما حاجتان لا تكرار.
DROP INDEX IF EXISTS waiting_list_one_open_per_patient_idx;

-- حاجةٌ بخدمةٍ محدَّدة: صفٌّ مفتوحٌ واحد لكل (مريض، خدمة).
CREATE UNIQUE INDEX IF NOT EXISTS waiting_list_one_open_per_patient_service_idx
  ON waiting_list (patient_id, service_id)
  WHERE status IN ('waiting', 'offered') AND service_id IS NOT NULL;

-- وحاجةٌ عامة بلا خدمة: صفٌّ عامٌّ مفتوحٌ واحد لكل مريض.
-- (فهرسان لا واحد: `NULL` في فهرسٍ فريد لا يتصادم مع `NULL`، فلا يحرس العامّ.)
CREATE UNIQUE INDEX IF NOT EXISTS waiting_list_one_open_generic_idx
  ON waiting_list (patient_id)
  WHERE status IN ('waiting', 'offered') AND service_id IS NULL;
