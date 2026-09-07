#!/usr/bin/env node
/**
 * النسخة الكاملة بملفٍّ واحد من سطر الأوامر — نفس ما تنزّله شاشة «النسخ والتصدير».
 * (من مستودع الوكيل الآخر لمكوّناتنا.)
 *
 * الاستعمال: DATABASE_URL=… DOCUMENTS_DIR=… npm run backup:full
 * والملف يُكتب في المجلد الحالي باسم يحمل تاريخه.
 */

import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fullBackupBlocks } from "../lib/fullBackup";
import { backupFileName } from "../lib/backup";
import { CLINIC_TIME_ZONE } from "../lib/db";

async function main() {
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  const target = `full-${backupFileName(date, time).replace(/\.sql$/, "")}.tar.gz`;

  const source = Readable.from(fullBackupBlocks());
  const gzip = createGzip({ level: 9 });
  source.on("error", (error) => gzip.destroy(error));
  await pipeline(source, gzip, createWriteStream(target));
  console.log(`كُتبت النسخة الكاملة: ${target}`);
}

main().catch((error) => {
  console.error("فشلت النسخة:", error instanceof Error ? error.message : error);
  process.exit(1);
});
