import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { backupSqlLines, getPool } from "./db";
import { readFileByKey } from "./files";
import { tarEnd, tarHeader, tarPadding } from "./tar";

/**
 * النسخة الكاملة بملفٍّ واحد — قاعدة البيانات **وأشعّة المرضى معًا**.
 * (منقولة من مستودع الوكيل الآخر aqlan-center-main لمكوّناتنا.)
 *
 * كانت نسختنا ملفين يُنزّلان كلٌّ على حدة، وأشعة المرضى تُنزّل أرشيفًا منفصلًا —
 * فمن نسي الثاني نزّل نصف ذاكرة المركز وظنّ أنه كلّها. وهنا الملف واحد:
 * `database.sql` ثم `documents/` ثم `manifest.json` **أخيرًا**.
 *
 * ### ولماذا `manifest.json` أخيرًا
 *
 * لأنّ التنزيل المقطوع لا يستطيع أن يتنكّر كنسخةٍ كاملة: من يفتح الملف الناقص
 * لا يجد المفتاح الأخير فيعرف أنّ عليه إعادة التنزيل. ولو كان أولًا لقرأه
 * «سليمة» وبنى سلامةً على نصف أرشيف.
 *
 * وكلّ مستند يُتحقَّق منه قبل إدراجه: البصمة والمقاس من الصف نفسه — فالمعطوب
 * **يُفشل النسخة كلّها** هنا لا أن يمرّ صامتًا ويُكتشف عند الاستعادة أسوأ أوقاته.
 */

export interface BackupDocument {
  id: number; storage_key: string; sha256: string; size_bytes: string | number;
  title: string; patient_id: number; removed_at: Date | null;
}

/**
 * SQL ثم قائمة المستندات (بما فيها المخفية) ثم الملفات ثم المفتاح.
 *
 * والدقيقة الحرجة هنا ترتيب القراءتين: **SQL أولًا والمستندات بعده**. فالملفات
 * غير قابلة للتعديل وتُكتب ذرّيًّا قبل وجود صفّها في القاعدة — فأي مستندٍ في
 * لقطة SQL مضمونٌ أنّ ملفّه على القرص لحظة قراءة المستندات بعدها. والعكس يترك
 * ثغرة: مستندٌ أُنشئ بين القراءتين يدخل SQL ويغيب ملفّه من الأرشيف.
 */
export async function* fullBackupBlocks(): AsyncGenerator<Uint8Array> {
  const base = resolve(tmpdir());
  const stage = await mkdtemp(join(base, "aqlan-backup-"));
  try {
    const sqlPath = join(stage, "database.sql");
    const sqlFile = await open(sqlPath, "wx", 0o600);
    const hash = createHash("sha256");
    try {
      for await (const line of backupSqlLines()) {
        hash.update(line);
        await sqlFile.writeFile(line);
      }
    } finally {
      await sqlFile.close();
    }

    const { rows: documents } = await getPool().query<BackupDocument>(
      "SELECT id, storage_key, sha256, size_bytes, title, patient_id, removed_at FROM patient_documents ORDER BY id",
    );

    const now = new Date();
    const sqlSize = (await stat(sqlPath)).size;
    yield tarHeader("database.sql", sqlSize, now);
    for await (const chunk of createReadStream(sqlPath)) yield chunk as Buffer;
    yield tarPadding(sqlSize);

    const included = new Set<string>();
    for (const document of documents) {
      if (included.has(document.storage_key)) continue;
      const bytes = await readFileByKey(document.storage_key);
      if (!bytes || bytes.length !== Number(document.size_bytes)
          || createHash("sha256").update(bytes).digest("hex") !== document.sha256) {
        throw new Error(`Backup document missing or corrupt: ${document.id}`);
      }
      yield tarHeader(`documents/${safeTarName(document.storage_key)}`, bytes.length, now);
      yield bytes;
      yield tarPadding(bytes.length);
      included.add(document.storage_key);
    }

    // يُكتب أخيرًا: التنزيل المقطوع لا يستطيع التنكر كنسخة كاملة.
    const manifest = Buffer.from(JSON.stringify({
      format: "aqlan-full-backup", version: 1, createdAt: now.toISOString(),
      databaseSha256: hash.digest("hex"),
      documents: documents.map((document) => ({
        id: document.id, storageKey: document.storage_key, sha256: document.sha256,
        sizeBytes: Number(document.size_bytes), title: document.title,
        patientId: document.patient_id, removedAt: document.removed_at,
      })),
    }, null, 2), "utf8");
    yield tarHeader("manifest.json", manifest.length, now);
    yield manifest;
    yield tarPadding(manifest.length);
    yield tarEnd();
  } finally {
    if (!resolve(stage).startsWith(base + sep)) throw new Error("Unsafe backup temporary path");
    await rm(stage, { recursive: true, force: true });
  }
}

/**
 * اسم آمن لمدخل الأرشيف: مفاتيح التخزين عندنا من نمط آمن أصلًا، لكن الحارس
 * هنا لا يثق بأحد — مدخلٌ يبدأ بـ`/` أو يحمل `..` يفسد الأرشيف كله.
 */
function safeTarName(key: string): string {
  const clean = key.replace(/[^A-Za-z0-9._-]/g, "_");
  return clean.startsWith(".") ? `d${clean}` : clean;
}
