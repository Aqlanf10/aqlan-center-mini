#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * هل تصل الأشعة إلى الملف — وهل تعود منه؟
 *
 * ثلاثة أسئلة لا يجيب عنها اختبار وحدة:
 *
 * ١) هل يُكتب الملف على القرص ويُقرأ منه بنفس البايتات؟ (وهو ما يقرّر إن كانت
 *    الأشعة سليمة أم تالفة — والتلف يُكتشف بعد سنة حين تُطلب للمقارنة.)
 * ٢) هل **يرفض** البرنامج الرفع حين لا يكون التخزين دائمًا؟ الفقد الصامت هنا
 *    أخطر من أي خلل آخر في هذه الوحدة.
 * ٣) هل يُفكّ أرشيف الأشعة بأداةٍ حقيقية — لا بقارئٍ كتبناه نحن؟
 */

const source = process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
if (!source.trim()) { console.error("خطأ: SOURCE_DATABASE_URL غير مضبوط."); process.exit(1); }

const sslFor = (url) => {
  const l = url.toLowerCase();
  if (l.includes("sslmode=disable")) return false;
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(l)) return false;
  return { rejectUnauthorized: false };
};
const withDatabase = (url, name) => {
  const parsed = new URL(url); parsed.pathname = `/${name}`; return parsed.toString();
};

const temporary = `documents_check_${Date.now()}`;
process.env.DATABASE_URL = withDatabase(source, temporary);
const store = mkdtempSync(join(tmpdir(), "docs-"));
process.env.DOCUMENTS_DIR = store;

const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

// صورة PNG صغيرة صالحة — بايتاتٌ حقيقية لا نصٌّ متنكّر.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${temporary}`);
  const db = await import("../lib/db.ts");
  const files = await import("../lib/files.ts");
  const storage = await import("../lib/storage.ts");
  await db.ensureSchema();

  const patient = await db.createPatient({
    fullName: "مريض الأشعة", phone: "770998877", altPhone: null, gender: "male",
    birthYear: null, address: null, medicalAlert: null, note: null,
  });

  console.log("\n  ── الملف على القرص لا في القاعدة ──");

  const stored = await files.putFile(PNG, "png");
  check("كُتب الملف", existsSync(join(store, stored.key)), stored.key);
  const back = await files.readFileByKey(stored.key);
  check("عاد بنفس البايتات", Buffer.compare(back, PNG) === 0, `${back.length} بايت`);

  const again = await files.putFile(PNG, "png");
  check("نفس المحتوى يُخزَّن مرة", again.deduplicated && again.key === stored.key);

  const document = await db.recordDocument({
    patientId: patient.id, visitId: null, kind: "xray", title: "بانورامي قبل العلاج",
    mimeType: "image/png", sizeBytes: stored.sizeBytes, sha256: stored.sha256,
    storageKey: stored.key, note: null, takenOn: "2026-08-01", uploadedBy: "فحص",
  });
  check("سُجّل وصفه في القاعدة", document.id > 0 && document.isImage);

  const { rows: blobs } = await db.getPool().query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'patient_documents' AND data_type IN ('bytea','oid')`,
  );
  check("ولا عمود بايتات في الجدول — المحظور ٨", blobs.length === 0,
    blobs.map((b) => b.column_name).join("، ") || "لا شيء");

  console.log("\n  ── الحراسة ──");

  const outside = await files.readFileByKey("../../etc/passwd");
  check("لا يُقرأ ملفٌّ خارج المجلّد", outside === null);

  const bigCheck = storage.validateUpload({ mimeType: "image/png", sizeBytes: 999_999_999 });
  check("الملف الضخم مرفوض", !bigCheck.ok, bigCheck.ok ? "" : bigCheck.message);
  const typeCheck = storage.validateUpload({ mimeType: "video/mp4", sizeBytes: 100 });
  check("النوع غير المقبول مرفوض", !typeCheck.ok);

  console.log("\n  ── الفقد الصامت: يُرفض بصوتٍ عالٍ ──");

  delete process.env.DOCUMENTS_DIR;
  const status = await files.storageStatus();
  check("بلا تخزين دائم: غير جاهز", !status.ready);
  check("والرسالة تقول ما يُضبط", status.message.includes("DOCUMENTS_DIR"), status.message);
  let refused = false;
  try { await files.putFile(PNG, "png"); } catch { refused = true; }
  check("والرفع يُرفض لا يُكتب في مكانٍ مؤقّت", refused);
  process.env.DOCUMENTS_DIR = store;

  console.log("\n  ── الأرشيف يُفكّ بأداةٍ حقيقية ──");

  const { tarHeader, tarPadding, tarEnd, safeEntryName } = await import("../lib/tar.ts");
  const rows = await db.documentsForArchive();
  check("الأرشيف يرى المستند", rows.length === 1);

  const parts = [];
  for (const row of rows) {
    const bytes = await files.readFileByKey(row.storageKey);
    const folder = safeEntryName(`${row.patientNumber} ${row.patientName}`, row.patientNumber);
    const name = `أشعة/${folder}/${row.id}-${safeEntryName(row.title, String(row.id))}.png`;
    parts.push(tarHeader(name, bytes.length, row.uploadedAt), bytes, tarPadding(bytes.length));
  }
  parts.push(tarEnd());
  const archive = join(store, "archive.tar");
  writeFileSync(archive, Buffer.concat(parts.map((p) => Buffer.from(p))));

  // GNU tar يهرّب البايتات غير اللاتينية في قائمته، فلا تُقارن القائمة نصًّا —
  // يُفكّ الأرشيف ويُقرأ ما خرج من القرص نفسه. وهذا هو السؤال الحقيقي أصلًا.
  execFileSync("tar", ["-tf", archive]);
  check("tar يقرأ الفهرس بلا خطأ", true);

  const out = mkdtempSync(join(tmpdir(), "untar-"));
  execFileSync("tar", ["-xf", archive, "-C", out]);
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path); else found.push(path);
    }
  };
  walk(out);
  check("خرج ملفٌّ واحد", found.length === 1, found.map((f) => f.slice(out.length + 1)).join("، "));
  check("واسمه العربي سليم بعد الفكّ",
    found[0].includes("بانورامي قبل العلاج") && found[0].includes("مريض الأشعة"),
    found[0].slice(out.length + 1));
  check("والمحتوى مطابقٌ بايتًا ببايت", Buffer.compare(readFileSync(found[0]), PNG) === 0);
  rmSync(out, { recursive: true, force: true });

  console.log("\n  ── الإخفاء توثيقٌ لا محو ──");

  const noReason = await db.removeDocument({ id: document.id, actor: "فحص", note: " " });
  check("لا إخفاء بلا سبب", !noReason.ok, noReason.ok ? "" : noReason.message);

  const removed = await db.removeDocument({ id: document.id, actor: "فحص", note: "رُفعت للمريض الخطأ" });
  check("أُخفي بسببٍ مكتوب", removed.ok);
  check("واختفى عن القائمة العادية", (await db.listPatientDocuments(patient.id)).length === 0);
  const withRemoved = await db.listPatientDocuments(patient.id, true);
  check("ويراه المدير معلَّمًا", withRemoved.length === 1 && withRemoved[0].removedNote === "رُفعت للمريض الخطأ");
  check("والملف باقٍ على القرص", existsSync(join(store, stored.key)));
  check("وخرج من الأرشيف", (await db.documentsForArchive()).length === 0);

  await db.getPool().end();
} catch (error) {
  console.error(`فشل: ${error.message}`);
  failed = true;
} finally {
  rmSync(store, { recursive: true, force: true });
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(failed
  ? "\nسقط الفحص."
  : "\nالأشعة تصل وتعود: على القرص لا في القاعدة، وتُرفض بصوتٍ عالٍ إن لم يكن التخزين دائمًا.");
process.exit(failed ? 1 : 0);
