/**
 * (DOCATTR-1) الطبيب الموقِّع في اختبارات التوقيع.
 *
 * التوقيع لم يعد يقبل عملًا مستحقًا بلا طبيبٍ معالج (كانت عمولته تضيع بصمت). الاختبارات التي
 * تصنع زيارةً بلا طبيب وتوقّعها بـ«doctor» تمثّل واقعًا واحدًا: طبيبٌ يوقّع زيارته — فيُمرَّر
 * جهته كما تمرّرها الواجهة من الجلسة. جهةٌ واحدة لكل ملف اختبار.
 */
let cached: number | null = null;

export async function signerDoctorPartyId(): Promise<number> {
  if (cached !== null) return cached;
  const { getPool } = await import("../../lib/db");
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', 'د. الموقِّع (اختبار)', 0) RETURNING id`);
  cached = rows[0].id;
  return cached;
}
