#!/usr/bin/env node
/**
 * تعبئة أبعاد الصور القديمة — من ترويسة الملف نفسه.
 * (منقول من مستودع الوكيل الآخر، محوَّل إلى tsx لوارداتنا.)
 *
 * الأبعاد تُقرأ وقت الرفع منذ إضافة `lib/imageSize.ts`، فما رُفع قبلها بلا
 * أبعاد. وهذا السكربت يمرّ على المستندات بلا أبعاد ويقرأها من الملف — فتُصبح
 * صالحة لطباعة التراكب والمقارنة دون إعادة رفع.
 *
 * الاستعمال: DATABASE_URL=… npm run backfill:image-size
 */

import { imageSize } from "../lib/imageSize";
import { readFileByKey } from "../lib/files";
import { getPool, ensureSchema } from "../lib/db";

async function main() {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; storage_key: string; mime_type: string;
  }>(
    `SELECT id, storage_key, mime_type FROM patient_documents
      WHERE (width IS NULL OR height IS NULL) AND mime_type LIKE 'image/%'
      ORDER BY id`,
  );
  if (rows.length === 0) {
    console.log("لا صورًا بلا أبعاد — لا شيء يُعبَّأ.");
    return;
  }

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const bytes = await readFileByKey(row.storage_key);
    const size = bytes ? imageSize(bytes) : null;
    if (!size) {
      // لا يُفشل الملفُ غير القابل للقراءة السكربتَ: يُعدّ ويُقال.
      skipped += 1;
      continue;
    }
    await getPool().query(
      `UPDATE patient_documents SET width = $2, height = $3 WHERE id = $1`,
      [row.id, size.width, size.height],
    );
    updated += 1;
  }
  console.log(`عُبِّئت أبعاد ${updated} مستندًا${skipped > 0 ? ` — و${skipped} غير قابلٍ للقراءة تُركت كما هي` : ""}.`);
}

main().catch((error) => {
  console.error("فشل التعبئة:", error instanceof Error ? error.message : error);
  process.exit(1);
});
