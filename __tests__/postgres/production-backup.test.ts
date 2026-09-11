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
import { adminClient, createIsolatedDatabase, TEST_DATABASE_URL } from "./_setup";
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

  it("(B) لقطة واحدة متسقة: إدراجٌ متزامن أثناء اللقطة لا يدخل SQL ولا metadata", async () => {
    // مغلّف يعلّق المسار عند SELECT metadata (بعد توليد SQL كامل) حتى يُجرى
    // الإدراج المتزامن عبر اتصالٍ آخر ثم يُترك الSELECT يكمل — فاللقطة
    // REPEATABLE READ التُقطت قبل الإدراج يجب ألا تراه في **الوجهين**.
    let reachedMetadata!: () => void;
    const metadataReached = new Promise<void>((resolve) => { reachedMetadata = resolve; });
    let releaseMetadata!: () => void;
    const concurrentMutationDone = new Promise<void>((resolve) => { releaseMetadata = resolve; });

    const realQuery = client.query.bind(client);
    const gateClient: DbPool = {
      query: (sql: string, values?: unknown[]) => {
        if (typeof sql === "string" && sql.includes("FROM patient_documents")) {
          reachedMetadata();
          return concurrentMutationDone.then(() => realQuery(sql, values as never[]));
        }
        return realQuery(sql, values as never[]);
      },
    } as unknown as DbPool;

    const backupPromise = (async () =>
      collectBlocks(productionBackupBlocksWithClient(gateClient, { documentsDir })))();

    await metadataReached;

    // اتصال متزامن على القاعدة المعزولة نفسها (بلا إعادة إنشاء)
    const concurrentUrl = new URL(TEST_DATABASE_URL);
    concurrentUrl.pathname = `/${DATABASE_NAME}`;
    const concurrent = new Client({ connectionString: concurrentUrl.toString(), ssl: false });
    await concurrent.connect();
    try {
      await concurrent.query("BEGIN");
      const { rows: evilPatient } = await concurrent.query<{ id: number }>(
        "INSERT INTO patients (patient_number, full_name, phone) VALUES ('BK-SNAP-EVIL', 'مريض سباق اللقطة', '777000999') RETURNING id",
      );
      await concurrent.query(
        `INSERT INTO patient_documents (patient_id, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
         VALUES ($1, 'سباق اللقطة', 'image/png', 5, $2, $3, 'pr21-test')`,
        [evilPatient[0].id, createHash("sha256").update("EVIL").digest("hex"), storageKeyOf("EVIL")],
      );
      await concurrent.query("COMMIT");
    } finally {
      await concurrent.end().catch(() => {});
    }
    releaseMetadata();

    const tar = await backupPromise;
    const parsed = parseTarBytes(tar);
    const sqlText = Buffer.from(parsed.entries.get("database.sql")!.data).toString("utf8");
    const manifest = JSON.parse(
      Buffer.from(parsed.entries.get("manifest.json")!.data).toString("utf8"),
    ) as { documentCount: number; documents: { storageKey: string }[] };

    // database.sql (وُلّد قبل الإدراج) لا يحمل المريض المتزامن
    expect(sqlText).not.toContain("BK-SNAP-EVIL");
    // metadata (قُرئت بعد الإدراج لكن داخل اللقطة نفسها) لا تراه أيضًا
    expect(manifest.documentCount).toBe(0);
    expect(manifest.documents).toHaveLength(0);

    // تنظيف صفوف السباق حتى لا تسرّب إلى بقية الاختبارات
    await client.query("DELETE FROM patient_documents WHERE uploaded_by = 'pr21-test' AND title = 'سباق اللقطة'");
    await client.query("DELETE FROM patients WHERE patient_number = 'BK-SNAP-EVIL'");
  });

  it("(D) صفّان بنفس storage_key ⇒ أرشيف مُتحقق بجسمٍ فيزيائي واحد ووصفٍ واحد", async () => {
    const content = "PG18-DEDUP-BYTES";
    const key = storageKeyOf(content);
    const sha = createHash("sha256").update(content, "utf8").digest("hex");
    await mkdir(path.join(documentsDir, path.dirname(key)), { recursive: true });
    await writeFile(path.join(documentsDir, key), content, "utf8");
    const { rows } = await client.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, phone) VALUES ('BK-DEDUP', 'مريض التكرار', '777000003') RETURNING id",
    );
    const patientId = rows[0].id;
    // صفّان مختلفا id لعنوان ومريض — نفس storage_key
    await client.query(
      `INSERT INTO patient_documents (patient_id, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1, 'نسخة أ', 'image/png', $2, $3, $4, 'pr21-test'), ($1, 'نسخة ب', 'image/png', $2, $3, $4, 'pr21-test')`,
      [patientId, Buffer.byteLength(content, "utf8"), sha, key],
    );

    const result = await runBackupCycle({
      triggerType: "manual",
      volumeRoot: volume,
      documentsDir,
      // أبكر من دورة الاختبار التالي (14:46) حتى تبقى نسخته الأحدث الممثِّل
      // لليوم ولا يحذفها الاحتفاظ قبل أن يتحقق منها هو نفسه.
      now: new Date("2026-09-11T14:40:00Z"),
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
    // عدد المستندات = أجسام فيزيقية فريدة لا صفوف قاعدة
    expect(result.backup?.documentCount).toBe(1);

    const finalPath = path.join(resolveBackupDirectory(volume), result.backup!.backupId);
    const { readTarGzEntries } = await import("../../lib/restore/archive");
    const { documentEntryName } = await import("../../lib/restore/archive");
    const parsed = await readTarGzEntries(finalPath);
    expect(parsed.order.filter((name) => name.startsWith("documents/"))).toEqual([documentEntryName(key)]);

    const manifest = JSON.parse(
      Buffer.from(parsed.entries.get("manifest.json")!.data).toString("utf8"),
    ) as { documentCount: number; documents: Record<string, unknown>[] };
    expect(manifest.documentCount).toBe(1);
    expect(manifest.documents).toHaveLength(1);
    // وصف الملف الفيزيقي بالحد الأدنى حصرًا: مفتاح + بصمة + حجم (بلا PHI)
    expect(Object.keys(manifest.documents[0]).sort()).toEqual(["sha256", "sizeBytes", "storageKey"]);
    expect(manifest.documents[0].storageKey).toBe(key);
    expect(manifest.documents[0].sha256).toBe(sha);
    expect(manifest.documents[0].sizeBytes).toBe(Buffer.byteLength(content, "utf8"));

    // تنظيف
    await client.query("DELETE FROM patient_documents WHERE storage_key = $1", [key]);
    await client.query("DELETE FROM patients WHERE patient_number = 'BK-DEDUP'");
    await rm(path.join(documentsDir, key), { force: true });
  });

  /** صفّان لنفس storage_key ببيانات فيزيائية متعارضة ⇒ النسخة تفشل مغلقًا. */
  async function expectConflictingDuplicateFails(options: {
    now: string;
    label: string;
    conflictingSha?: string;
    conflictingSize?: number;
  }): Promise<void> {
    const content = `PG18-CONFLICT-${options.label}`;
    const key = storageKeyOf(content);
    const sha = createHash("sha256").update(content, "utf8").digest("hex");
    await mkdir(path.join(documentsDir, path.dirname(key)), { recursive: true });
    await writeFile(path.join(documentsDir, key), content, "utf8");
    const { rows } = await client.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, phone) VALUES ($1, $2, '777000004') RETURNING id",
      [`BK-CONFLICT-${options.label}`, `مريض التعارض ${options.label}`],
    );
    const patientId = rows[0].id;
    // الصفّان: الأول يصف الملف الفيزيائي الحقيقي، والثاني يحمل التعارض المطلوب
    await client.query(
      `INSERT INTO patient_documents (patient_id, title, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ($1, 'الصف الحقيقي', 'image/png', $2, $3, $4, 'pr21-test'),
              ($1, 'الصف المتعارض', 'image/png', $5, $6, $4, 'pr21-test')`,
      [
        patientId,
        Buffer.byteLength(content, "utf8"),
        sha,
        key,
        options.conflictingSize ?? Buffer.byteLength(content, "utf8"),
        options.conflictingSha ?? sha,
      ],
    );

    const filesBefore = (await import("node:fs/promises")).readdir;
    const backupDir = resolveBackupDirectory(volume);
    const finalsBefore = (await filesBefore(backupDir).catch(() => [] as string[]))
      .filter((entry) => !entry.startsWith("."));

    const result = await runBackupCycle({
      triggerType: "manual",
      volumeRoot: volume,
      documentsDir,
      now: new Date(options.now),
      config: {
        backupEnabled: true, scheduleEnabled: true, scheduleTime: "03:00",
        scheduleTimeZone: "Asia/Aden", retentionDailyCount: 30, retentionWeeklyCount: 12,
        destinations: { railwayVolume: true, googleDrive: false },
      },
      blocks: () => productionBackupBlocksWithClient(client, { documentsDir }),
      log: () => {},
    });

    // فشل مغلق: لا نسخة verified، ولا أرشيف نهائي جديد باسم المحاولة
    expect(result.backup?.status).toBe("failed");
    expect(result.backup?.message).toMatch(/تعارض/);
    const finalsAfter = (await filesBefore(backupDir).catch(() => [] as string[]))
      .filter((entry) => !entry.startsWith("."));
    expect(finalsAfter).toEqual(finalsBefore);
    expect(finalsAfter).not.toContain(result.backup!.backupId);

    await client.query("DELETE FROM patient_documents WHERE storage_key = $1", [key]);
    await client.query("DELETE FROM patients WHERE patient_number = $1", [`BK-CONFLICT-${options.label}`]);
    await rm(path.join(documentsDir, key), { force: true });
  }

  it("(C) نفس storage_key ببصمتين مختلفتين ⇒ النسخة تفشل مغلقًا (لا اختيار أول صفٍّ بصمت)", async () => {
    await expectConflictingDuplicateFails({
      now: "2026-09-11T14:41:00Z",
      label: "SHA",
      conflictingSha: "e".repeat(64),
    });
  });

  it("(C) نفس storage_key بحجمين مختلفين ⇒ النسخة تفشل مغلقًا", async () => {
    await expectConflictingDuplicateFails({
      now: "2026-09-11T14:42:00Z",
      label: "SIZE",
      conflictingSize: 999999,
    });
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
