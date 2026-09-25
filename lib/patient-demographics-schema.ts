/**
 * (P2-8) بيانات المريض الناقصة — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0018_patient_demographics.sql` حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * - تاريخ الميلاد الكامل (اختياري): عمر مريض التقويم بالأشهر يحكم توقيت العلاج
 *   (قمة النمو)، وسنة الميلاد وحدها تخطئ بسنةٍ كاملة. سنة الميلاد تبقى وتُشتقّ منه.
 * - وليّ الأمر وهاتفه: أغلب مرضى التقويم أطفال — ومن يُتّصل به ويوقّع هو وليّهم.
 * - رقم الهوية/الجواز (اختياري).
 * أعمدة جديدة كلها قابلة للفراغ: لا صفّ قديم يتأثّر.
 */
export const PATIENT_DEMOGRAPHICS_SQL = `ALTER TABLE patients ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS guardian_name TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS guardian_phone TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS national_id TEXT;`;
