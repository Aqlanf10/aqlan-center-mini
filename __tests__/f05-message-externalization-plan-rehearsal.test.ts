/**
 * بروفة اصطناعية معزولة لخطة فصل مرفقات الرسائل المستقبلية (F-05 Safe Externalization Plan Rehearsal)
 *
 * تختبر الخطة المقترحة على بيانات اصطناعية فقط داخل PGlite مؤقت بالذاكرة ومجلد مؤقت معزول،
 * دون لمس أي مرفق مريض حقيقي ودون تعديل أي هجرة قائمة في المستودع.
 *
 * الثوابت المختبرة:
 * 1. التوافق المزدوج (Dual-Read): قراءة الرسائل الموروثة (Base64 داخل القاعدة) والرسائل المفصولة
 *    (ملف معنوَن بالمحتوى على القرص مع امتداد معزول .msgpng / .msgpdf) معًا بلا انقطاع.
 * 2. الترحيل المرحلي غير المدمّر (--keep-inline): كتابة الملف وبصمته SHA-256 والتحقق من قراءته
 *    الفيزيائية قبل ملء storage_key مع إبقاء file_data الأصلي خلال فترة المراقبة والنسخ الاحتياطي.
 * 3. الإغلاق الآمن عند التفريغ (--null-inline-verified): رفض تصفير file_data إذا كان ملف القرص
 *    غائبًا أو اختلفت بصمته أو حجمه عن المسجّل.
 * 4. عزل الامتدادات والعدّ المرجعي عند حذف الرسائل والنسخ الاحتياطي: عدم مساس ملفات patient_documents
 *    حتى عند تطابق البايتات حرفيًا، وعدم حذف ملف مشترك بين رسالتين نشطتين، وتضمين المرفقات النشطة في جرد النسخة الاحتياطية.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { putFile, readFileByKey, removeFileByKey } from "@/lib/files";
import { isSafeKey, storageKey } from "@/lib/storage";

const MSG_RESERVED_EXTENSIONS: Record<string, string> = {
  "image/png": "msgpng",
  "image/jpeg": "msgjpg",
  "image/webp": "msgwebp",
  "application/pdf": "msgpdf",
  "audio/webm": "msgwebm",
};

const SYNTHETIC_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

const SYNTHETIC_PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "utf8");

describe("F-05: بروفة اصطناعية آمنة لخطة فصل مرفقات الرسائل المستقبلية (بلا لمس بيانات حقيقية)", () => {
  let tempDocsDir = "";
  let prevDocsDir: string | undefined;
  let pg: PGlite;

  beforeEach(async () => {
    prevDocsDir = process.env.DOCUMENTS_DIR;
    tempDocsDir = await mkdtemp(join(tmpdir(), "f05-msg-plan-synthetic-"));
    process.env.DOCUMENTS_DIR = tempDocsDir;
    pg = new PGlite("memory://");
    await pg.exec(`
      CREATE TABLE patient_documents (
        id SERIAL PRIMARY KEY,
        storage_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id SERIAL PRIMARY KEY,
        file_name TEXT,
        file_mime TEXT,
        file_size INTEGER,
        file_data TEXT,
        file_storage_key TEXT,
        file_sha256 TEXT,
        deleted_at TIMESTAMPTZ
      );
    `);
  });

  afterEach(async () => {
    await pg.close();
    if (prevDocsDir === undefined) delete process.env.DOCUMENTS_DIR;
    else process.env.DOCUMENTS_DIR = prevDocsDir;
    if (tempDocsDir) await rm(tempDocsDir, { recursive: true, force: true });
  });

  async function dualReadPayload(messageId: number): Promise<Buffer | null> {
    const { rows } = await pg.query<{
      file_storage_key: string | null;
      file_sha256: string | null;
      file_size: number | null;
      file_data: string | null;
    }>(
      `SELECT file_storage_key, file_sha256, file_size, file_data
         FROM messages
        WHERE id = $1 AND deleted_at IS NULL`,
      [messageId],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.file_storage_key) {
      const diskBytes = await readFileByKey(row.file_storage_key);
      if (diskBytes) {
        const liveSha = createHash("sha256").update(diskBytes).digest("hex");
        if (liveSha === row.file_sha256 && diskBytes.length === row.file_size) {
          return diskBytes;
        }
      }
    }
    if (row.file_data) {
      return Buffer.from(row.file_data, "base64");
    }
    return null;
  }

  async function backfillKeepInlineBatch(limit: number): Promise<number> {
    const { rows } = await pg.query<{
      id: number;
      file_mime: string;
      file_size: number;
      file_data: string;
    }>(
      `SELECT id, file_mime, file_size, file_data
         FROM messages
        WHERE deleted_at IS NULL
          AND file_data IS NOT NULL
          AND file_storage_key IS NULL
        ORDER BY id ASC
        LIMIT $1`,
      [limit],
    );
    let migrated = 0;
    for (const row of rows) {
      const ext = MSG_RESERVED_EXTENSIONS[row.file_mime];
      if (!ext) continue;
      const decoded = Buffer.from(row.file_data, "base64");
      if (decoded.length === 0) continue;
      const stored = await putFile(decoded, ext);
      const verifyDisk = await readFileByKey(stored.key);
      if (!verifyDisk) throw new Error("فشل التحقق الفيزيائي بعد الكتابة");
      const verifySha = createHash("sha256").update(verifyDisk).digest("hex");
      if (verifySha !== stored.sha256 || verifyDisk.length !== decoded.length) {
        throw new Error("عدم تطابق البصمة بعد الكتابة");
      }
      // المرحلة 3: نثبت مفتاح القرص مع إبقاء file_data سليمًا حتى تكتمل دورة النسخ الاحتياطي المتحقق منها
      await pg.query(
        `UPDATE messages
            SET file_storage_key = $2,
                file_sha256 = $3,
                file_size = $4
          WHERE id = $1 AND deleted_at IS NULL`,
        [row.id, stored.key, stored.sha256, stored.sizeBytes],
      );
      migrated += 1;
    }
    return migrated;
  }

  async function nullInlineVerifiedBatch(): Promise<{ cleared: number; refused: number }> {
    const { rows } = await pg.query<{
      id: number;
      file_storage_key: string;
      file_sha256: string;
      file_size: number;
    }>(
      `SELECT id, file_storage_key, file_sha256, file_size
         FROM messages
        WHERE deleted_at IS NULL
          AND file_data IS NOT NULL
          AND file_storage_key IS NOT NULL`,
    );
    let cleared = 0;
    let refused = 0;
    for (const row of rows) {
      const diskBytes = await readFileByKey(row.file_storage_key);
      const liveSha = diskBytes ? createHash("sha256").update(diskBytes).digest("hex") : null;
      if (!diskBytes || liveSha !== row.file_sha256 || diskBytes.length !== row.file_size) {
        refused += 1;
        continue;
      }
      await pg.query(`UPDATE messages SET file_data = NULL WHERE id = $1`, [row.id]);
      cleared += 1;
    }
    return { cleared, refused };
  }

  async function softDeleteExternalizedMessage(messageId: number): Promise<void> {
    const { rows } = await pg.query<{ old_key: string | null }>(
      `UPDATE messages
          SET deleted_at = NOW(),
              file_name = NULL,
              file_mime = NULL,
              file_size = NULL,
              file_data = NULL,
              file_storage_key = NULL,
              file_sha256 = NULL
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING (SELECT file_storage_key FROM messages WHERE id = $1) AS old_key`,
      [messageId],
    );
    void rows;
  }

  it("ينفّذ الترحيل غير المدمّر والتحقق بالبصمة والرفض الآمن عند تلف القرص وعزل الحذف والنسخ الاحتياطي", async () => {
    // 1. مستند مريض رسمي على نفس البايتات الاصطناعية (امتداد .png مقابل .msgpng المعزول للرسائل)
    const patientDocStored = await putFile(SYNTHETIC_PNG, "png");
    expect(isSafeKey(patientDocStored.key)).toBe(true);
    await pg.query(
      `INSERT INTO patient_documents (storage_key, sha256, size_bytes) VALUES ($1, $2, $3)`,
      [patientDocStored.key, patientDocStored.sha256, patientDocStored.sizeBytes],
    );

    // 2. رسالتان موروثتان تشتركان في نفس صورة PNG + رسالة PDF ثالثة
    const r1 = await pg.query<{ id: number }>(
      `INSERT INTO messages (file_name, file_mime, file_size, file_data)
       VALUES ('x1.png', 'image/png', $1, $2),
              ('x2.png', 'image/png', $1, $2),
              ('consent.pdf', 'application/pdf', $3, $4)
       RETURNING id`,
      [
        SYNTHETIC_PNG.length,
        SYNTHETIC_PNG.toString("base64"),
        SYNTHETIC_PDF.length,
        SYNTHETIC_PDF.toString("base64"),
      ],
    );
    const [msg1, msg2, msg3] = r1.rows.map((r) => r.id);

    // القراءة المزدوجة تعمل قبل الترحيل من file_data مباشرة
    expect(await dualReadPayload(msg1)).toEqual(SYNTHETIC_PNG);

    // 3. المرحلة 3 (--keep-inline): ترحيل بالدفعات مع إبقاء file_data كنسخة أمان
    const migratedCount = await backfillKeepInlineBatch(10);
    expect(migratedCount).toBe(3);

    const afterBackfill = await pg.query<{
      id: number;
      file_storage_key: string;
      file_data: string | null;
    }>(`SELECT id, file_storage_key, file_data FROM messages ORDER BY id ASC`);
    expect(afterBackfill.rows[0].file_storage_key).toMatch(/\.msgpng$/);
    expect(afterBackfill.rows[0].file_storage_key).not.toBe(patientDocStored.key);
    expect(isSafeKey(afterBackfill.rows[0].file_storage_key)).toBe(true);
    expect(storageKey(patientDocStored.sha256, "msgpng")).toBe(afterBackfill.rows[0].file_storage_key);
    // file_data لم يُحذف بعد في المرحلة 3
    expect(afterBackfill.rows[0].file_data).not.toBeNull();

    // 4. محاكاة تلف طارئ على ملف PDF على القرص قبل المرحلة 4: يجب أن يرفض تصفير file_data ويحمي البايتات!
    const pdfKey = afterBackfill.rows[2].file_storage_key;
    await writeFile(join(tempDocsDir, pdfKey), Buffer.from("CORRUPTED", "utf8"));

    const phase4 = await nullInlineVerifiedBatch();
    expect(phase4).toEqual({ cleared: 2, refused: 1 });

    // الرسالتان السليمتان تقرآن من القرص بعد تصفير file_data، والرسالة التالف ملفها ما زالت تقرأ من file_data المحفوظ!
    expect(await dualReadPayload(msg1)).toEqual(SYNTHETIC_PNG);
    expect(await dualReadPayload(msg2)).toEqual(SYNTHETIC_PNG);
    expect(await dualReadPayload(msg3)).toEqual(SYNTHETIC_PDF);

    // 5. حذف الرسالة الأولى لا يحذف ملف القرص لأن الرسالة الثانية ما زالت تشير إليه، ولا يمس مستند المريض الرسمي
    const sharedMsgKey = afterBackfill.rows[0].file_storage_key;
    await pg.query(
      `UPDATE messages
          SET deleted_at = NOW(), file_name = NULL, file_mime = NULL, file_size = NULL,
              file_data = NULL, file_storage_key = NULL, file_sha256 = NULL
        WHERE id = $1`,
      [msg1],
    );
    const { rows: remainingRefs1 } = await pg.query<{ still_used: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM messages WHERE file_storage_key = $1 AND deleted_at IS NULL
       ) AS still_used`,
      [sharedMsgKey],
    );
    expect(remainingRefs1[0].still_used).toBe(true);
    expect(await dualReadPayload(msg1)).toBeNull();
    expect(await dualReadPayload(msg2)).toEqual(SYNTHETIC_PNG);

    // عند حذف الرسالة الثانية أيضًا يصبح المرجع صفرًا فيُحذف ملف .msgpng وحده، بينما يبقى ملف مستند المريض (.png) سليمًا!
    await softDeleteExternalizedMessage(msg2);
    const { rows: remainingRefs2 } = await pg.query<{ still_used: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM messages WHERE file_storage_key = $1 AND deleted_at IS NULL
       ) AS still_used`,
      [sharedMsgKey],
    );
    expect(remainingRefs2[0].still_used).toBe(false);
    await removeFileByKey(sharedMsgKey);
    expect(await readFileByKey(sharedMsgKey)).toBeNull();
    expect(await readFileByKey(patientDocStored.key)).toEqual(SYNTHETIC_PNG);

    // 6. جرد النسخة الاحتياطية الموحّد (UNION ALL) يلتقط مستندات المرضى ومرفقات الرسائل النشطة معًا بلا تكرار مفتاح
    const repairedPdf = await putFile(SYNTHETIC_PDF, "msgpdf");
    expect(repairedPdf.key).toBe(pdfKey);
    await writeFile(join(tempDocsDir, pdfKey), SYNTHETIC_PDF);
    const { rows: backupManifestRows } = await pg.query<{
      id: string;
      storage_key: string;
      sha256: string;
      size_bytes: number;
    }>(`
      SELECT 'doc-' || id AS id, storage_key, sha256, size_bytes FROM patient_documents
      UNION ALL
      SELECT 'msg-file-' || id AS id, file_storage_key AS storage_key, file_sha256 AS sha256, file_size AS size_bytes
        FROM messages
       WHERE deleted_at IS NULL AND file_storage_key IS NOT NULL
      ORDER BY id
    `);
    expect(backupManifestRows).toHaveLength(2);
    expect(backupManifestRows.map((r) => r.storage_key)).toEqual([
      patientDocStored.key,
      pdfKey,
    ]);
  });
});
