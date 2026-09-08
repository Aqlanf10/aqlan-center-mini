#!/usr/bin/env node
/**
 * npm run db:migrate — تطبيق الهجرات المُرقَّمة (P1.1 + P1.21).
 *
 * قواعد الأمان (فشلٌ مغلق افتراضيًا):
 *  ١) يطبع هوية قاعدة الهدف (المضيف/المنفذ/القاعدة/المستخدم — لا كلمات سر أبدًا).
 *  ٢) الافتراضي dry-run: لا شيء يُطبَّق إلا بعلم --apply الصريح.
 *  ٣) هدف بعيد (غير localhost) يتطلب --allow-remote إضافيًا — لا هجرة لقاعدة
 *     بعيدة بنقرة عرضية.
 *  ٤) يرفض العمل على PGlite (USE_LOCAL_DB) — الهجرات لقاعدة حقيقية.
 *  ٥) لا تنفيذ إطلاقًا ضد الإنتاج في هذه المرحلة (P1): Railway/production
 *     مرفوض بنيويًّا إن شُغِّل من داخل بيئة إنتاج فعلية.
 *
 * الاستعمال:
 *   npm run db:migrate                        # dry-run: يعرض ما سيل فقط
 *   npm run db:migrate -- --apply             # تطبيق محلي (localhost)
 *   npm run db:migrate -- --apply --allow-remote   # تطبيق لقاعدة بعيدة، بوعي
 */
import { Client } from "pg";

function arg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const DRY_RUN_BANNER = "DRY-RUN — بلا --apply لن يُطبَّق شيء";

async function main(): Promise<number> {
  const raw = process.env.DATABASE_URL ?? "";
  const apply = arg("apply");
  const allowRemote = arg("allow-remote");

  if (!raw.trim()) {
    console.error("DATABASE_URL غير مضبوط — الهجرات تحتاج قاعدة PostgreSQL حقيقية.");
    return 1;
  }
  if (process.env.USE_LOCAL_DB === "true") {
    console.error("USE_LOCAL_DB=true (PGlite) — نظام الهجرات لقاعدة حقيقية لا للمحاكي الذاكري.");
    return 1;
  }
  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_PROJECT_ID) {
    console.error(
      "بيئة إنتاج مكتشفة (NODE_ENV=production أو RAILWAY_PROJECT_ID) — تطبيق الهجرات على "
      + "الإنتاج غير مسموح في P1. قرار التشغيل بعد المراجعة المستقلة.",
    );
    return 1;
  }

  const { decideTls, parseDatabaseHost } = await import("../lib/db-tls");
  const identity = parseDatabaseHost(raw);
  console.log("─".repeat(60));
  console.log("هدف الهجرة (بلا كلمة سر):");
  console.log(`  host=${identity?.host}  port=${identity?.port}`);
  console.log(`  database=${identity?.database}  user=${identity?.user}`);
  console.log(`  tls=${decideTls(raw).mode}`);
  console.log("─".repeat(60));

  if (identity && !["localhost", "127.0.0.1", "::1"].includes(identity.host) && !allowRemote) {
    console.error(
      "الهدف بعيد و--allow-remote غير ممرَّرة — رفض افتراضيًا. إن كان المقصود فعلًا أضف العلم بوعي كامل.",
    );
    return 1;
  }

  const { loadMigrationFiles, migrate, migrationStatus } = await import("../lib/migrations");
  const files = await loadMigrationFiles();
  console.log(`الملفات: ${files.map((file) => file.version).join("، ")}`);

  const client = new Client({
    connectionString: raw,
    ssl: decideTls(raw).ssl === false ? false : { ...(decideTls(raw).ssl as object) },
  });
  try {
    await client.connect();
    const pool = {
      query: (sql: string, values?: unknown[]) => client.query(sql, values as never[]),
      connect: async () => ({
        query: (sql: string, values?: unknown[]) => client.query(sql, values as never[]),
        release: () => {},
      }),
    };

    if (!apply) {
      const status = await migrationStatus(pool, files);
      console.log(`\n${DRY_RUN_BANNER}`);
      console.log(`  معتمدة سابقًا: ${status.applied.map((row) => row.version).join("، ") || "(لا شيء)"}`);
      console.log(`  ستُطبَّق:      ${status.pending.map((file) => file.version).join("، ") || "(لا شيء — محدَّثة)"}`);
      console.log(`  فحص التوافق:  ${status.probe.ok ? "سليم" : `ناقص: ${status.probe.missing.join("، ")}`}`);
      if (status.emptyDatabase) console.log("  القاعدة فارغة — خط الأساس سيُطبَّق كاملًا.");
      if (status.unknownApplied.length) console.log(`  ⚠️ صفوف مجهولة: ${status.unknownApplied.map((row) => row.version).join("، ")}`);
      if (status.checksumMismatches.length) console.log(`  ⚠️ بصمات مخالفة: ${status.checksumMismatches.map((entry) => entry.version).join("، ")}`);
      return 0;
    }

    const result = await migrate(pool, { apply: true, files });
    if (result.adoptedBaseline) console.log("اعتماد خط الأساس لقاعدة قائمة (بلا تنفيذ DDL — حفاظًا على البيانات).");
    if (result.appliedVersions.length === 0) console.log("لا هجرات ناقصة — القاعدة محدَّثة أصلًا.");
    for (const version of result.appliedVersions) {
      console.log(`✔ طُبِّقت ${version}`);
    }
    const status = await migrationStatus(pool, files);
    console.log(`\nالحالة النهائية: ${status.consistent ? "متسقة ✅" : "غير متسقة ⚠️"}`);
    if (!status.consistent) {
      console.log(`  الناقص: ${status.pending.map((file) => file.version).join("، ")}`);
      console.log(`  المجهول: ${status.unknownApplied.map((row) => row.version).join("، ")}`);
      console.log(`  البصمات المخالفة: ${status.checksumMismatches.map((entry) => entry.version).join("، ")}`);
      console.log(`  فحص التوافق: ${status.probe.missing.join("، ")}`);
      return 2;
    }
    return 0;
  } catch (error) {
    console.error(`فشلت الهجرة: ${error instanceof Error ? error.message : String(error)}`);
    console.error("(الهجرة معاملاتيّة: فشلٌ في المنتصف يتراجع بكل شيء ويعيد Run لاحق المحاولة من نفس النقطة)");
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
