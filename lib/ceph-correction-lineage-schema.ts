/**
 * (ORTHO-ID-2) أصل تصحيح دراسة السيفالو — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0047_ceph_correction_lineage.sql` حرفيًّا
 * (الرقم 0047 محجوز لهذا العمل من dot: تعليق التنسيق على #314، 2026-10-09). إضافيٌّ خالص: عمودٌ قابل للفراغ
 * وقيودٌ وفهرسان، بلا حذف ولا إعادة تسمية ولا تعبئة لصفٍّ قائم — النسخ القديمة التي سبقت هذا العمود تبقى بلا
 * أصل مسجَّل (فارغ) ولا يُخمَّن لها أصل من نص الملاحظة.
 *
 * - `corrects_analysis_id`: الدراسة المعتمدة التي تصحّحها هذه المسودة/النسخة. فارغ = ليست تصحيحًا.
 * - `corrects_analysis_id < id`: لا ربط ذاتي ولا دورة — السلسلة تتناقص دائمًا نحو الأقدم.
 * - المفتاح الأجنبي المركّب `(patient_id, corrects_analysis_id)` يفرض أن الأصل لمريض التصحيح نفسه في القاعدة،
 *   ويحتاج فهرسًا فريدًا على `(patient_id, id)`.
 * - مسودة واحدة لكل مريض أصلًا (`ceph_analyses_one_draft`) فتصحيح مفتوح واحد لكل أصل دون فهرس إضافي.
 */
export const CEPH_CORRECTION_LINEAGE_SQL = `ALTER TABLE ceph_analyses ADD COLUMN IF NOT EXISTS corrects_analysis_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS ceph_analyses_patient_id_key ON ceph_analyses (patient_id, id);
DO $ceph_lineage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ceph_analyses'::regclass AND conname = 'ceph_analyses_corrects_older_chk') THEN
    ALTER TABLE ceph_analyses ADD CONSTRAINT ceph_analyses_corrects_older_chk
      CHECK (corrects_analysis_id IS NULL OR corrects_analysis_id < id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ceph_analyses'::regclass AND conname = 'ceph_analyses_corrects_same_patient_fk') THEN
    ALTER TABLE ceph_analyses ADD CONSTRAINT ceph_analyses_corrects_same_patient_fk
      FOREIGN KEY (patient_id, corrects_analysis_id) REFERENCES ceph_analyses (patient_id, id);
  END IF;
END
$ceph_lineage$;
CREATE INDEX IF NOT EXISTS ceph_analyses_corrects_idx ON ceph_analyses (corrects_analysis_id) WHERE corrects_analysis_id IS NOT NULL;
`;
