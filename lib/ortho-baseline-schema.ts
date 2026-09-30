/**
 * (CASE-1) الحالة التقويمية السابقة (قبل النظام) — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0034_ortho_legacy_baseline.sql`
 * حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا. إضافيٌّ خالص: أعمدةٌ قابلة للفراغ على `ortho_cases`،
 * لا حذف ولا إعادة تسمية ولا تعبئة لصفٍّ قائم (كل حالةٍ قديمة تبقى `baseline_kind IS NULL`).
 *
 * - `baseline_kind`: «legacy» حين تُسجَّل الحالة لقطةً لعلاجٍ بدأ قبل النظام — بلا فواتير ولا زيارات وهمية.
 * - `baseline_recorded_at`: لحظة تسجيل اللقطة (يُدقَّق الفعل باسم مسجّله).
 * - `elastics`: المطاطات الحالية كما وصفها الطبيب.
 * - `responsible_doctor_id`: الطبيب المسؤول عن الحالة (جهةٌ من نوع طبيب).
 * - `legacy_financial_mode`: كيف عومل المال قبل النظام — المال يستمر عبر الأرصدة الافتتاحية والخطط القائمة.
 * - `remaining_objectives`: ما بقي من أهداف العلاج.
 *
 * لا فهرس فريد على `ortho_adjustments (case_id, visit_id)` هنا: قد تحمل القاعدة أزواجًا مكررة
 * (التقرير `ortho-duplicate-adjustments` يكشفها)، والفهرس يأتي بعد تسويتها بقرار المالك.
 */
export const ORTHO_BASELINE_SQL = `ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS baseline_kind TEXT CHECK (baseline_kind IN ('legacy'));
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS baseline_recorded_at TIMESTAMPTZ;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS elastics TEXT;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS responsible_doctor_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS legacy_financial_mode TEXT
  CHECK (legacy_financial_mode IN ('opening_balance', 'prepaid_included', 'per_session', 'installments'));
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS remaining_objectives TEXT;
`;
