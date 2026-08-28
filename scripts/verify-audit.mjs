#!/usr/bin/env node
import "./load-env.mjs";
import { Client } from "pg";

/**
 * هل سجل التدقيق **غير قابل للتعديل فعلًا**؟
 *
 * ادعاء «السجل لا يُحذف» بلا إثبات أسوأ من غيابه: من يثق به يبني عليه قرارًا. وهذا
 * الفحص يحاول التعديل والحذف **من اتصال مباشر بالقاعدة** — أوسع صلاحية ممكنة —
 * ويشترط أن يفشل كلاهما. فالحماية في القاعدة نفسها لا في أدب الكود.
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
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};

const temporary = `audit_check_${Date.now()}`;
const target = withDatabase(source, temporary);
process.env.DATABASE_URL = target;

const admin = new Client({ connectionString: source, ssl: sslFor(source) });
let failed = false;

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${temporary}`);

  const db = await import("../lib/db.ts");
  await db.ensureSchema();

  await db.recordAudit({
    action: "payment.create", entity: "payment", entityId: 1, entityLabel: "R-00001",
    details: { المبلغ: 50000, كلمة_السر: "يجب ألا تُكتب", token: "سرّ" },
    actor: "فحص", actorRole: "admin",
  });
  const [entry] = await db.listAudit({});
  if (!entry) { console.error("لم يُكتب السطر."); failed = true; }
  else console.log(`كُتب: ${entry.summary} — بيد ${entry.actor}`);

  // الأسرار لا تدخل السجل.
  const keys = Object.keys(entry?.details ?? {});
  if (keys.some((k) => /pass|token|سر/i.test(k))) {
    console.error(`خلل: تسرّب مفتاح حسّاس إلى السجل: ${keys.join("، ")}`);
    failed = true;
  } else {
    console.log(`التفاصيل بلا أسرار: ${keys.join("، ")}`);
  }

  const direct = new Client({ connectionString: target, ssl: sslFor(target) });
  await direct.connect();

  for (const [label, sql] of [
    ["التعديل", `UPDATE audit_log SET actor = 'شخص آخر' WHERE id = ${entry.id}`],
    ["الحذف", `DELETE FROM audit_log WHERE id = ${entry.id}`],
    ["الحذف الشامل", `DELETE FROM audit_log`],
  ]) {
    try {
      await direct.query(sql);
      console.error(`خلل: ${label} نجح — والسجل يجب أن يرفضه.`);
      failed = true;
    } catch (error) {
      console.log(`رُفض ${label}: ${error.message.trim()}`);
    }
  }

  const { rows } = await direct.query("SELECT COUNT(*)::int AS n, MIN(actor) AS actor FROM audit_log");
  if (rows[0].n !== 1 || rows[0].actor !== "فحص") {
    console.error(`خلل: السجل تغيّر — ${rows[0].n} سطرًا بيد ${rows[0].actor}.`);
    failed = true;
  } else {
    console.log("السجل سليم بعد كل المحاولات: سطر واحد بيد فحص.");
  }
  await direct.end();
  await db.getPool().end();
} catch (error) {
  console.error(`فشل: ${error.message}`);
  failed = true;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${temporary}`).catch(() => {});
  await admin.end().catch(() => {});
}
process.exit(failed ? 1 : 0);
