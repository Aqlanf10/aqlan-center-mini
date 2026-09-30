/**
 * (CHAIR-1 — Slice 1) إقرار جاهزية المريض للكرسي — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0037_visit_clearance.sql`
 * حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا. إضافيٌّ خالص: عمودان قابلان للفراغ على
 * `visits`، لا حذف ولا إعادة تسمية ولا تعبئة لصفٍّ قائم.
 *
 * - `visits.cleared_at`: متى أقرّت الاستقبال (أو الطبيب) بأن المريض جاهز للكرسي بعد الاطلاع على
 *   قائمة الجاهزية المشتقة (التاريخ الطبي، التنبيهات والأعلام، الاستمارة). الفارغ = لم يُقَرّ بعد،
 *   ويُعامل تمامًا كما كان قبل هذه الهجرة.
 * - `visits.cleared_by`: اسم المستخدم الذي أقرّ.
 *
 * القائمة نفسها **مشتقة لا مخزَّنة** (lib/chair-readiness.ts)، وقيم `visits.status` لا تتغيّر:
 * شاشة الصالة والتقارير والاختبارات تقرؤها بالمعنى نفسه.
 */
export const VISIT_CLEARANCE_SQL = `ALTER TABLE visits ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS cleared_by TEXT;
`;
