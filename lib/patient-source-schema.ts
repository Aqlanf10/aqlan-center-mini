/**
 * (P3-8ب) من أين جاء المريض — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0022_patient_referral_source.sql` حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * «توصية مريض» أم «طبيب أحاله» أم «وسائل التواصل»؟ سؤالٌ يجيب عن أين يُصرف جهد
 * التسويق، ومن الطبيب الذي يستحق شكرًا على إحالاته. عمودان اختياريان: لا صفّ قديم يتأثر.
 */
export const PATIENT_SOURCE_SQL = `ALTER TABLE patients ADD COLUMN IF NOT EXISTS referral_source TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS referred_by TEXT;`;
