import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import type { DbPool } from "../../lib/db";
import { parseTarBytes } from "../../lib/restore/archive";
import {
  productionBackupBlocksWithClient,
  readDocumentWithRealpathGuard,
} from "../../lib/productionBackup";
import { runBackupCycle } from "../../lib/backupEngine";
import { resolveBackupDirectory } from "../../lib/backupVolume";
import { readBackupHistory } from "../../lib/backupHistory";
import { adminClient, createIsolatedDatabase } from "./_setup";
import { storageKeyOf } from "../helpers/backup-blocks";

/**
 * اختبارات PostgreSQL 18 المعزول لمسار النسخ الإنتاجي — الإثبات على قاعدة حقيقية:
 *
 * ١) توليد dump كامل من قاعدة 18 فعلية (55 جدولًا من 0001) بمولّد الإنتاج نفسه.
 * ٢) مسار الاستعلام للقاعدة SELECT/BEGIN/COMMIT/SET حصرًا — لا DML ولا DDL.
 * ٣) اللقطة REPEATABLE READ READ ONLY (النص الفعلي المُرسَل يُفحص).
 * ٤) الجلسة READ ONLY ترفض أي كتابة فعلية (INSERT يُرفض من الخادم نفسه).
 * ٥) دورة محرك كاملة: أرشيف نهائي مُتحقق + history + مستندات حقيقية بقراءة realpath.
 * ٦) حارس symlink على قاعدة حقيقية: مستندٌ يخرج من الدليل يُفشل النسخة.
 */

const DATABASE_NAME = `aqlan_backup_gate_${process.pid}_${Date.now()}`.toLowerCase();
let client: Client;

let volume: string;
let documentsDir: string;

beforeAll(async () => {
  const url = await createIsolatedDatabase(DATABASE_NAME);
  client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  const baselineSql = await readFile(path.resolve("migrations/0001_baseline_schema.sql"), "utf8");
  await client.query(baselineSql);

  volume = await mkdtemp(path.join(tmpdir(), "aqlan-pg-backup-volume-"));
  documentsDir = path.join(volume, "documents");
  await mkdir(documentsDir, { recursive: true });
});

afterAll(async () => {
  await client?.end().catch(() => {});
  const admin = adminClient("postgres");
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE_NAME} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  await rm(volume, { recursive: true, force: true }).catch(() => {});
});

/** مغلّف تسجيل: يصطاد كل SQL يُرسَل فعليًّا إلى القاعدة. */
function recordingClient(target: Client, sink: string[]): DbPool {
  const realQuery = target.query.bind(target);
  return {
    query: (sql: string, values?: unknown[]) => {
      sink.push(sql);
      return realQuery(sql, values as never[]);
    },
  } as unknown as DbPool;
}

async function collectBlocks(generator: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of generator) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("مسار قاعدة البيانات في النسخ الإنتاجي على PostgreSQL 18", () => {
  it("يولّد dump كاملًا: database.sql غير فارغ + manifest ببصمة مطابقة وإصدار PG", async () => {
    const tar = await collectBlocks(productionBackupBlocksWithClient(client, {
      documentsDir,
      appCommitSha: "1d004aa8dce5d885167beab9e41832638381dab1",
    }));
    const parsed = parseTarBytes(tar);

    expect(parsed.truncated).toBe(false);
    const sqlEntry = parsed.entries.get("database.sql");
    expect(sqlEntry).toBeDefined();
    const sqlText = Buffer.from(sqlEntry!.data).toString("utf8");
    expect(sqlText.length).toBeGreaterThan(100);
    expect(sqlText).toContain("COMMIT;");
    expect(sqlText).toContain("-- patients (");
    expect(parsed.order[parsed.order.length - 1]).toBe("manifest.json");

    const manifest = JSON.parse(Buffer.from(parsed.entries.get("manifest.json")!.data).toString("utf8")) as {
      databaseSha256: string; pgVersion?: string; appCommitSha?: string; documentCount: number;
    };
    expect(manifest.databaseSha256).toBe(createHash("sha256").update(sqlEntry!.data).digest("hex"));
    expect(manifest.pgVersion).toMatch(/^18(\.\d+)?$/);
    expect(manifest.appCommitSha).toBe("1d004aa8dce5d885167beab9e41832638381dab1");
    expect(manifest.documentCount).toBe(0);

    // الجلسة أعيدت لحالها بعد المولّد: الكتابة مسموحة مجددًا على الاتصال نفسه
    await client.query("CREATE TABLE IF NOT EXISTS public.__pr21_post_dump (id integer)");
    await client.query("DROP TABLE public.__pr21_post_dump");
  });

  it("مسار الاستعلام المُرسَل للقاعدة: BEGIN/COMMIT/SET/SELECT حصرًا — لا DML ولا DDL", async () => {
    const recorded: string[] = [];
    const probe = recordingClient(client, recorded);
    const tar = await collectBlocks(productionBackupBlocksWithClient(probe, { documentsDir }));
    expect(tar.length).toBeGreaterThan(0);

    // المسار يبدأ بقفل الجلسة READ ONLY ثم لقطة REPEATABLE READ READ ONLY
    expect(recorded[0]).toBe("SET default_transaction_read_only = on");
    expect(recorded).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(recorded[recorded.length - 1]).toBe("SET default_transaction_read_only = off");

    for (const statement of recorded) {
      expect(statement.trim()).toMatch(/^(SET|BEGIN|COMMIT|ROLLBACK|SELECT)\b/i);
    }
    expect(recorded.join("\n")).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|CALL|DO)\b/i,
    );
  });

  it("الجلسة READ ONLY ترفض كتابةً فعلية من الخادم نفسه (لا ثقة بالنوايا)", async () => {
    await client.query("CREATE TABLE IF NOT EXISTS public.__pr21_write_probe (id integer)");
    try {
      await client.query("SET default_transaction_read_only = on");
      await client.query("BEGIN");
      let rejected = false;
      try {
        await client.query("INSERT INTO public.__pr21_write_probe (id) VALUES (1)");
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      await client.query("ROLLBACK");
    } finally {
      await client.query("SET default_transaction_read_only = off").catch(() => {});
      await client.query("DROP TABLE IF EXISTS public.__pr21_write_probe");
    }
  });
});

describe("دورة المحرك كاملة على PostgreSQL 18 مع مستندات حقيقية", () => {
  it("نسخة مُتحققة: أرشيف نهائي + بصمة مطابقة + مستند داخل الأرشيف + history", async () => {
    // مريض ومستند حقيقي: ملف على القرص الدائم + صف في الفهرس.
    const content = "PG18-DOCUMENT-BYTES-أشعة";
    const key = storageKeyOf(content);
    const sha = createHash("sha256").update(content, "utf8").digest("hex");
    await mkdir(path.join(documentsDir, path.dirname(key)), { recursive: true });
    await writeFile(path.join(documentsDir, key), content, "utf8");
    const { rows } = await client.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, phone) VALUES ('BK-001', 'مريض النسخ', '777000001') RETURNING id",
    );
    await client.query(
      `INSERT INTO patient_documents (patient_id, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1, 'أشعة اختبار', 'image/png', $2, $3, $4, 'pr21-test')`,
      [rows[0].id, Buffer.byteLength(content, "utf8"), sha, key],
    );

    const helpers = await import("../helpers/backup-blocks");
    void helpers;
    const result = await runBackupCycle({
      triggerType: "scheduled",
      volumeRoot: volume,
      documentsDir,
      now: new Date("2026-09-11T14:46:00Z"),
      config: {
        backupEnabled: true, scheduleEnabled: true, scheduleTime: "03:00",
        scheduleTimeZone: "Asia/Aden", retentionDailyCount: 30, retentionWeeklyCount: 12,
        destinations: { railwayVolume: true, googleDrive: false },
      },
      blocks: () => productionBackupBlocksWithClient(client, { documentsDir }),
      log: () => {},
    });

    expect(result.ran).toBe(true);
    expect(result.backup?.status).toBe("verified");
    expect(result.backup?.documentCount).toBe(1);
    expect(result.replicationStatus).toBe("complete");

    const finalPath = path.join(resolveBackupDirectory(volume), result.backup!.backupId);
    const fileStat = await stat(finalPath);
    expect(fileStat.size).toBe(result.backup!.archiveBytes);
    const archiveBytes = await readFile(finalPath);
    expect(createHash("sha256").update(archiveBytes).digest("hex")).toBe(result.backup!.archiveSha256);

    // الأرشيف نفسه يفك ويتحقق: المستند موجود بداخله وبصمته مطابقة
    const { createGzip } = await import("node:zlib");
    void createGzip;
    const { readTarGzEntries } = await import("../../lib/restore/archive");
    const { validateBackupArchive } = await import("../../lib/restore/validate");
    const parsed = await readTarGzEntries(finalPath);
    const validated = validateBackupArchive(parsed, { documentsDir });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.documents).toHaveLength(1);
      expect(Buffer.from(validated.documents[0].bytes).toString("utf8")).toBe(content);
    }

    const history = await readBackupHistory(resolveBackupDirectory(volume));
    expect(history.find((entry) => entry.backupId === result.backup!.backupId)?.status).toBe("verified");

    // تنظيف صفوف الاختبار (قاعدة معزولة تُسقط كليًّا بعد ذلك أصلًا)
    await client.query("DELETE FROM patient_documents WHERE storage_key = $1", [key]);
    await client.query("DELETE FROM patients WHERE patient_number = 'BK-001'");
  });

  it("حارس realpath على قاعدة حقيقية: مستندٌ رابطٌ رمزي خارج الدليل يُفشل النسخة", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "aqlan-pg-outside-"));
    try {
      const outsideFile = path.join(outsideDir, "classified.png");
      await writeFile(outsideFile, "outside-bytes");
      const escapedKey = "ee/ff/" + "e".repeat(64) + ".png";
      await mkdir(path.join(documentsDir, "ee/ff"), { recursive: true });
      const { symlink } = await import("node:fs/promises");
      await symlink(outsideFile, path.join(documentsDir, escapedKey));

      const { rows } = await client.query<{ id: number }>(
        "INSERT INTO patients (patient_number, full_name, phone) VALUES ('BK-002', 'مريض الرابط', '777000002') RETURNING id",
      );
      await client.query(
        `INSERT INTO patient_documents (patient_id, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
         VALUES ($1, 'رابط خارجي', 'image/png', 13, $2, $3, 'pr21-test')`,
        [rows[0].id, createHash("sha256").update("outside-bytes").digest("hex"), escapedKey],
      );

      const result = await runBackupCycle({
        triggerType: "manual",
        volumeRoot: volume,
        documentsDir,
        now: new Date("2026-09-11T14:47:00Z"),
        config: {
          backupEnabled: true, scheduleEnabled: true, scheduleTime: "03:00",
          scheduleTimeZone: "Asia/Aden", retentionDailyCount: 30, retentionWeeklyCount: 12,
          destinations: { railwayVolume: true, googleDrive: false },
        },
        blocks: () => productionBackupBlocksWithClient(client, { documentsDir }),
        log: () => {},
      });

      expect(result.backup?.status).toBe("failed");
      expect(result.backup?.message).toMatch(/رابط رمزي/);
      // لا نسخة نهائية للمحاولة الفاشلة
      const { readdir } = await import("node:fs/promises");
      const files = (await readdir(resolveBackupDirectory(volume))).filter((entry) => !entry.startsWith("."));
      // النسخة السابقة (المحاكمة في الاختبار الأول) قد تبقى — لا ملف جديد باسم هذه المحاولة
      expect(files).not.toContain(result.backup!.backupId);

      await client.query("DELETE FROM patient_documents WHERE storage_key = $1", [escapedKey]);
      await client.query("DELETE FROM patients WHERE patient_number = 'BK-002'");
      await rm(path.join(documentsDir, escapedKey), { force: true });
    } finally {
      await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("قراءة المستند السليم عبر الحارس تعيد البايتات نفسها", async () => {
    const content = "guard-ok-bytes";
    const key = storageKeyOf(content);
    await mkdir(path.join(documentsDir, path.dirname(key)), { recursive: true });
    await writeFile(path.join(documentsDir, key), content, "utf8");
    const bytes = await readDocumentWithRealpathGuard(key, documentsDir);
    expect(bytes.toString("utf8")).toBe(content);
  });
});
