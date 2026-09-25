/**
 * «يوم العيادة» في SQL بصيغةٍ يستعملها الفهرس.
 *
 * الصيغة القديمة `(arrived_at AT TIME ZONE $z)::date = …` تحوّل كل صفٍّ في الجدول قبل
 * المقارنة، فلا يُستعمل فهرس arrived_at ويُقرأ جدول الزيارات كله — وقائمة اليوم تُستطلع
 * كل عشرين ثانية من كل شاشة مفتوحة، والجدول يكبر كل يوم. النطاق نفسه يُكتب هنا حدًّا
 * أدنى وأعلى على العمود كما هو: من منتصف ليل اليوم بتوقيت العيادة إلى منتصف ليل غده.
 * النتيجة واحدة، والقراءة من الفهرس.
 *
 * النصوص ثابتة من الشيفرة (أسماء أعمدة ومعاملات $n) — لا مدخلات مستخدم.
 */

/** اليوم الحالي بتوقيت العيادة، تعبير SQL من نوع date. */
export function clinicTodaySql(zoneParam: string): string {
  return `(NOW() AT TIME ZONE ${zoneParam})::date`;
}

/** `column` يقع في اليوم `dayExpr` (تعبير date) بتوقيت العيادة. */
export function onClinicDaySql(column: string, zoneParam: string, dayExpr: string): string {
  return onClinicDaysSql(column, zoneParam, dayExpr, dayExpr);
}

/**
 * `column` يقع بين اليومين `fromExpr` و`toExpr` (شاملين) بتوقيت العيادة.
 *
 * جزآن: نطاقٌ واسع على العمود (يومٌ زائد من كل طرف) يقرؤه الفهرس فيضيّق القراءة إلى
 * أيامٍ قليلة، ثم الفحص الدقيق لكل صفٍّ داخل ذلك النطاق وحده. الفحص الدقيق هو ما يضمن
 * الصحة في منطقةٍ يتكرر فيها منتصف الليل عند نهاية التوقيت الصيفي (هافانا مثلًا)،
 * حيث يختار تحويل «منتصف الليل» إلى لحظةٍ واحدةً من اثنتين فيسقط ساعة. عدن بلا توقيت
 * صيفي، لكن المنطقة قابلة للتهيئة فتُكتب الصحة لكل منطقة.
 */
export function onClinicDaysSql(column: string, zoneParam: string, fromExpr: string, toExpr: string): string {
  return `${column} >= ((${fromExpr})::timestamp AT TIME ZONE ${zoneParam}) - INTERVAL '1 day'`
    + ` AND ${column} < (((${toExpr}) + 1)::timestamp AT TIME ZONE ${zoneParam}) + INTERVAL '1 day'`
    + ` AND (${column} AT TIME ZONE ${zoneParam})::date BETWEEN (${fromExpr}) AND (${toExpr})`;
}
