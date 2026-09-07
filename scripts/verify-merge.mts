/**
 * تحقق سريع من المخطط المدمَج (من مستودع الوكيل الآخر) على PGlite محليًا:
 * الجداول الجديدة، الأعمدة الجديدة، ترحيلة بوابة التسعير، ودوال القيمة/النسب.
 * تشغيله: USE_LOCAL_DB=true npx tsx scripts/verify-merge.mts
 */
import { PGlite } from "@electric-sql/pglite";

async function main() {
  process.env.USE_LOCAL_DB = "true";
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = "";
  process.env.RAILWAY_PROJECT_ID = "";
  const { getPool, ensureSchema } = await import("../lib/db");
  void PGlite; // يُستخدم داخل db.ts نفسها

  await ensureSchema();
  const pool = getPool();

  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('login_limits','material_rates','prescriptions')`,
  );
  const names = tables.map((row) => row.table_name).sort();
  console.log("الجداول الجديدة:", names.join(", "));
  if (names.length !== 3) throw new Error("جدول مفقود من الثلاثة الجديدة");

  const { rows: cols } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public'
        AND ((table_name='patient_documents' AND column_name IN ('width','height'))
          OR (table_name='inventory_movements' AND column_name IN ('unit_cost_minor','is_return'))
          OR (table_name='services' AND column_name IN ('price_configured','price_provisional')))`,
  );
  console.log("الأعمدة الجديدة:", cols.map((row) => `${row.table_name}.${row.column_name}`).join(", "));
  if (cols.length !== 6) throw new Error("عمود مفقود من الستة الجديدة");

  const { rows: marker } = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'migration.services_price_gate'`,
  );
  console.log("علامة ترحيلة التسعير:", marker[0]?.value ?? "غير موجودة");

  const { rows: stats } = await pool.query<{ total: number; configured: number }>(
    `SELECT COUNT(*) FILTER (WHERE is_active)::int AS total,
            COUNT(*) FILTER (WHERE is_active AND price_configured)::int AS configured
       FROM services`,
  );
  console.log(`الخدمات النشطة: ${stats[0].total} — المسعّرة (بعد الترحيلة): ${stats[0].configured}`);

  // الترحيلة الأولى: كل نشطٍ له سعر يصير «مسعّرًا».
  if (marker[0] && stats[0].total > 0 && stats[0].configured < stats[0].total) {
    // قد تكون كلها صفر السعر؟ البذر يضع أسعارًا فعلية:
    throw new Error("الترحيلة لم تعلّم الأسعار القائمة");
  }

  console.log("✓ المخطط المدمَج سليم على PGlite");
}

main().catch((error) => {
  console.error("فشل التحقق:", error instanceof Error ? error.message : error);
  process.exit(1);
});
