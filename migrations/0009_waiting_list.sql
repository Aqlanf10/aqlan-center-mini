-- (المرحلة ٥) قائمة الانتظار — كيانٌ مستقلّ عن طابور اليوم.
--
-- المرحلة ٤ب جعلت المحرّك **يرفض** الحجز حين يمتلئ اليوم. والرفض صواب، لكنه
-- بلا وجهةٍ يعني مريضًا ضاع: تقول له الاستقبال «لا يوجد مكان» فيُغلق الهاتف،
-- ثم يُلغي مريضٌ آخر موعده بعد ساعتين فيبقى الكرسي فارغًا. فقائمة الانتظار هي
-- الجانب الآخر من الحارس: من رُدّ يُكتب، ومن أُفرج له مكانٌ يُنادى.
--
-- وهي **ليست** طابور صالة الانتظار (`visits` ومن وصل اليوم) — ذاك من حضر،
-- وهذه من لم يجد موعدًا أصلًا.
--
-- والقاعدة المُلزمة: **القائمة تقترح ولا تحجز**. موعدٌ يُفرض على مريضٍ لم يؤكّد
-- هو وعدٌ لا يستطيع المركز الوفاء به — وهي السابقة نفسها في `booking_requests`:
-- المريض يطلب ولا يحجز.

CREATE TABLE IF NOT EXISTS waiting_list (
  id                SERIAL      PRIMARY KEY,
  patient_id        INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- الخدمة المطلوبة: تحدّد المدّة والفواصل حين يُحجز فعلًا.
  service_id        INTEGER     REFERENCES appointment_services(id) ON DELETE SET NULL,
  -- طبيبٌ بعينه إن طلبه المريض — وإلا فأيّ طبيب.
  doctor_id         INTEGER     REFERENCES parties(id) ON DELETE SET NULL,
  -- المدى المقبول. فارغٌ يعني «أيّ وقت» — ولا يُفترض مدىً لم يقله المريض.
  earliest_date     DATE,
  latest_date       DATE,
  preferred_period  TEXT        NOT NULL DEFAULT 'any',
  -- الأولوية: ألمٌ حادّ لا ينتظر كما ينتظر فحصٌ دوريّ.
  urgency           TEXT        NOT NULL DEFAULT 'normal',
  -- مدّةٌ يطلبها المستخدم صراحةً؛ الغياب يعني مدّة الخدمة.
  duration_minutes  INTEGER,
  note              TEXT,
  status            TEXT        NOT NULL DEFAULT 'waiting',
  -- أثرُ النداء: من نادى ومتى — فلا يُنادى المريض مرتين ولا يُنسى.
  offered_at        TIMESTAMPTZ,
  offered_by        TEXT,
  -- الموعد الذي انتهى إليه الانتظار، إن حُجز.
  appointment_id    INTEGER     REFERENCES appointments(id) ON DELETE SET NULL,
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT,
  resolution_reason TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- الاستعلام الغالب: «من ينتظر الآن؟» مرتَّبين بالأولوية ثم بأقدمهم انتظارًا.
CREATE INDEX IF NOT EXISTS waiting_list_open_idx
  ON waiting_list (status, urgency, created_at);
CREATE INDEX IF NOT EXISTS waiting_list_patient_idx
  ON waiting_list (patient_id, status);
-- مريضٌ واحد لا ينتظر مرتين — والحارس في القاعدة لا في فحصٍ يسبق الإدراج.
-- موظّفتان تسجّلان المريض نفسه في اللحظة نفسها: فحصٌ ثم إدراج يمرّ كلتيهما،
-- فيُنادى الاسم مرتين ويُحتسب مرتين، ويُغلق أحدُهما فيبقى الآخر معلّقًا بلا سبب.
-- وهو المبدأ نفسه الذي يحكم انتقال حالة الموعد: الحارس داخل الجملة.
CREATE UNIQUE INDEX IF NOT EXISTS waiting_list_one_open_per_patient_idx
  ON waiting_list (patient_id) WHERE status IN ('waiting', 'offered');
CREATE INDEX IF NOT EXISTS waiting_list_window_idx
  ON waiting_list (earliest_date, latest_date);
