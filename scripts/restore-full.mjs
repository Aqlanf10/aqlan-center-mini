#!/usr/bin/env node
import "./load-env.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Client } from "pg";
/** مجلد المستندات المضبوط — أو `null` إن لم يُضبط (يتعذّر نسخ الأشعة حينها). */
function documentsDirectory() {
  const raw = process.env.DOCUMENTS_DIR?.trim();
  return raw ? resolve(raw) : null;
}

/**
 * استعادة النسخة الكاملة بملفٍّ واحد — البيانات والأشعة معًا.
 * (منقول من مستودع الوكيل الآخر ومكيّف لسكربت استعادة SQL عندنا.)
 *
 * الخطوات: فكّ الضغط، فحص المفتاح (manifest.json) الأخير، استعادة database.sql
 * على قاعدة فارغة (بمنطق restore.mjs نفسه)، ثم نسخ documents/ إلى
 * DOCUMENTS_DIR بتحقّق البصمة لكل ملف.
 *
 * الاستعمال:
 *   SKIP_SEED=true DATABASE_URL=… node scripts/restore-full.mjs النسخة.tar.gz
 */

const file = process.argv[2];
const url = process.env.DATABASE_URL ?? "";
if (!file || !url.trim()) {
  console.error("الاستعمال: SKIP_SEED=true DATABASE_URL=… node scripts/restore-full.mjs النسخة.tar.gz");
  process.exit(1);
}

function sslFor(target) {
  const lowered = target.toLowerCase();
  if (lowered.includes("sslmode=disable")) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(lowered)) return false;
  return { rejectUnauthorized: false };
}

/** قراءة أرشيف tar كاملًا في الذاكرة (بعد فكّ gzip) واستخراج مدخلاته. */
async function readTarEntries(gzipPath) {
  const stage = await mkdtemp(join(tmpdir(), "aqlan-restore-"));
  const tarPath = join(stage, "archive.tar");
  await pipeline(createReadStream(gzipPath), createGunzip(), (await import("node:fs")).createWriteStream(tarPath));
  const bytes = await readFile(tarPath);

  const entries = new Map();
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    if (!name) break; // مدخل النهاية
    const size = parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0", 8);
    const type = header[156];
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    if (type === 48 || type === 0) entries.set(name.replace(/^\.\//, ""), data);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  await rm(stage, { recursive: true, force: true });
  return entries;
}

async function main() {
  const entries = await readTarEntries(file);

  /* المفتاح آخر ما يُكتب عند النسخ: وجودُه شهادة اكتمال — والناقص يُرفض قبل
     أن يلمس قاعدةً حيّة أو يمسح مجلد أشعة قائمًا. */
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) {
    console.error("الأرشيف بلا manifest.json — التنزيل انقطع قبل اكتماله. لا يُستعاد منه شيء.");
    process.exit(1);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.format !== "aqlan-full-backup") {
    console.error("صيغة الأرشيف غير معروفة:", manifest.format);
    process.exit(1);
  }
  const sql = entries.get("database.sql");
  if (!sql || !sql.toString("utf8").includes("COMMIT;")) {
    console.error("ملف البيانات ناقص أو بلا خاتمة سليمة. لا يُستعاد منه شيء.");
    process.exit(1);
  }
  const sqlHash = createHash("sha256").update(sql).digest("hex");
  if (sqlHash !== manifest.databaseSha256) {
    console.error("بصمة ملف البيانات لا تطابق المفتاح — الأرشيف تالف أو مُعدَّل.");
    process.exit(1);
  }

  /* ١) استعادة القاعدة — فوق قاعدة فارغة (لا TRUNCATE: الاستعادة فوق بيانات
     تفشل باصطدام المفاتيح، وهو الفشل الصحيح). */
  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();
  try {
    await client.query(sql.toString("utf8"));
    console.log("استُعيدت قاعدة البيانات.");
  } finally {
    await client.end();
  }

  /* ٢) الأشعة — مع تحقّق البصمة والمقاس لكل ملف قبل نسخه. */
  const documentsDir = documentsDirectory();
  if (!documentsDir) {
    console.error("DOCUMENTS_DIR غير مضبوط — استُعيدت البيانات وبقيت الأشعة في الأرشيف.");
    process.exit(2);
  }
  await mkdir(documentsDir, { recursive: true });
  let restored = 0;
  let failed = 0;
  for (const document of manifest.documents ?? []) {
    const data = entries.get(`documents/${document.storageKey}`);
    if (!data || data.length !== document.sizeBytes
        || createHash("sha256").update(data).digest("hex") !== document.sha256) {
      console.error(`مستند تالف أو ناقص: ${document.storageKey} (${document.title})`);
      failed += 1;
      continue;
    }
    const target = resolve(documentsDir, document.storageKey);
    if (!target.startsWith(resolve(documentsDir))) throw new Error("مسار غير آمن في الأرشيف");
    await writeFile(target, data);
    restored += 1;
  }
  console.log(`استُعيد ${restored} مستندًا${failed > 0 ? ` — و${failed} تالفًا رُفضت` : ""}.`);
  if (failed > 0) process.exit(3);
}

main().catch((error) => {
  console.error("فشلت الاستعادة:", error instanceof Error ? error.message : error);
  process.exit(1);
});
