import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { loadMigrationFiles, migrate, migrationStatus, BASELINE_VERSION } from "../../lib/migrations";

/**
 * اختبارات مجسّ توافق خط الأساس القوي على PostgreSQL حقيقي (P1-FIX-1).
 *
 * السيناريوهات المطلوبة من المراجعة المستقلة:
 *  * قاعدة قائمة بنفس الجداول لكن عمود ناقص ⇒ DENY.
 *  * نوع مختلف ⇒ DENY.
 *  * قيد فريد ناقص ⇒ DENY.
 *  * مفتاح أجنبي ناقص ⇒ DENY.
 *  * فهرس حرج ناقص ⇒ DENY.
 *  * (وtrigger حرج ناقص ⇒ DENY.)
 *  * مخطط P0 قائم سليم ⇒ الاعتماد ينجح بلا فقد بيانات.
 *
 * «قاعدة قائمة» هنا = قاعدة أُنشئ مخططها بتنفيذ 0001 نصًّا (وهو حرفيًّا ما
 * كان ensureSchema ينتجه في P0) ثم أُدخلت بيانات — تمامًا كقاعدة الإنتاج
 * الحالية قبل معرفة نظام الهجرات.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const files = await loadMigrationFiles();

/** pool-محاكٍ حول Client واحد — كما تفعل أدوات CLI. */
function clientAsPool(client: Client) {
  return {
    query: (sql: string, values?: unknown[]) => client.query(sql, values as never[]),
    connect: async () => ({
      query: (sql: string, values?: unknown[]) => client.query(sql, values as never[]),
      release: () => {},
    }),
  };
}

async function withFreshP0Database(name: string): Promise<{ url: string; pool: ReturnType<typeof clientAsPool>; client: Client }> {
  const url = await createIsolatedDatabase(name);
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  // مخطط P0: 0001 نصًّا (ما كان ensureSchema ينتجه) + صف بيانات واحد
  await client.query(files[0].sql);
  await client.query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('P0-1', 'مريض إنتاج قائم')`,
  );
  return { url, pool: clientAsPool(client), client };
}

const databases: string[] = [];
afterAll(async () => {
  // القواعد المعزولة تُسقطها createIsolatedDatabase في الجولة القادمة؛ لا
  // تنظيف إضافي مطلوب — بيئة اختبار فقط.
  void databases;
});

describe("مجسّ توافق خط الأساس (P1-FIX-1) — PostgreSQL حقيقي", () => {
  it("قاعدة P0 قائمة سليمة ⇒ الاعتماد ينجح بلا فقد بيانات وتُطبَّق 0002+", async () => {
    const { pool, client } = await withFreshP0Database("aqlan_p1_probe_ok");
    databases.push("aqlan_p1_probe_ok");
    try {
      const result = await migrate(pool, { apply: true, files });
      expect(result.adoptedBaseline).toBe(true);
      expect(result.appliedVersions).toContain(BASELINE_VERSION);
      for (const file of files) {
        expect(result.appliedVersions).toContain(file.version);
      }

      // البيانات بقيت — الاعتماد لم يمس صفًّا
      const { rows } = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM patients WHERE patient_number = 'P0-1'`,
      );
      expect(rows[0].n).toBe(1);

      // وهجرات ما بعد الأساس طُبِّقت فعلًا (عمود idempotency موجود)
      const { rows: colRows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_name = 'payments' AND column_name = 'idempotency_request_hash') AS exists`,
      );
      expect(colRows[0].exists).toBe(true);

      const status = await migrationStatus(pool, files);
      expect(status.consistent).toBe(true);
      const baseline = status.applied.find((row) => row.version === BASELINE_VERSION);
      expect(baseline?.adopted).toBe(true);
    } finally {
      await client.end().catch(() => {});
    }
  });

  it("db:status عبر migrationStatus يعرض نتيجة المجسّ للمخطط السليم", async () => {
    const { pool, client } = await withFreshP0Database("aqlan_p1_probe_status");
    databases.push("aqlan_p1_probe_status");
    try {
      const status = await migrationStatus(pool, files);
      expect(status.baselineDiff).not.toBeNull();
      expect(status.baselineDiff!.ok).toBe(true);
      // فحص الاتساع: العناصر الحرجة التي قارنها المجسّ موجودة فعلاً
      expect(status.baselineDiff!.checked.tables).toBeGreaterThanOrEqual(50);
      expect(status.baselineDiff!.checked.columns).toBeGreaterThan(300);
      expect(status.baselineDiff!.missingTables).toEqual([]);
    } finally {
      await client.end().catch(() => {});
    }
  });

  const driftCases: Array<{ name: string; label: string; mutate: string }> = [
    {
      name: "aqlan_p1_drift_col",
      label: "نفس الجداول لكن عمود ناقص ⇒ DENY",
      mutate: `ALTER TABLE payments DROP COLUMN note`,
    },
    {
      name: "aqlan_p1_drift_type",
      label: "نوع مختلف لعمود مالي (BIGINT→INTEGER) ⇒ DENY",
      mutate: `ALTER TABLE payments ALTER COLUMN amount_minor TYPE INTEGER USING amount_minor::integer`,
    },
    {
      name: "aqlan_p1_drift_uniq",
      label: "قيد فريد ناقص (receipt_number) ⇒ DENY",
      mutate: `ALTER TABLE payments DROP CONSTRAINT payments_receipt_number_key`,
    },
    {
      name: "aqlan_p1_drift_fk",
      label: "مفتاح أجنبي ناقص (invoice_items→invoices) ⇒ DENY",
      mutate: `ALTER TABLE invoice_items DROP CONSTRAINT invoice_items_invoice_id_fkey`,
    },
    {
      name: "aqlan_p1_drift_index",
      label: "فهرس حرج ناقص (visits_arrived_at_idx) ⇒ DENY",
      mutate: `DROP INDEX visits_arrived_at_idx`,
    },
    {
      name: "aqlan_p1_drift_trigger",
      label: "trigger حرج ناقص (audit_log_no_update) ⇒ DENY",
      mutate: `DROP TRIGGER audit_log_no_update ON audit_log`,
    },
    {
      name: "aqlan_p1_drift_null",
      label: "إبطال مختلف لعمود (NOT NULL→nullable) ⇒ DENY",
      mutate: `ALTER TABLE payments ALTER COLUMN patient_id DROP NOT NULL`,
    },
  ];

  for (const drift of driftCases) {
    it(`انحراف: ${drift.label}`, async () => {
      const { pool, client } = await withFreshP0Database(drift.name);
      databases.push(drift.name);
      try {
        await client.query(drift.mutate);

        await expect(migrate(pool, { apply: true, files })).rejects.toThrow(/BASELINE_SCHEMA_MISMATCH/);

        // لا تسجيل للأساس أبدًا بعد الرفض: الرفض سبق أي إنشاء لجدول التسجيل
        const { rows } = await client.query<{ exists: boolean }>(
          "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
        );
        expect(rows[0].exists).toBe(false);

        // وdb:status يعرض الاختلاف الحقيقي لا «موجود تقريبًا»
        const status = await migrationStatus(pool, files);
        expect(status.baselineDiff).not.toBeNull();
        expect(status.baselineDiff!.ok).toBe(false);
        expect(status.consistent).toBe(false);
        expect(
          status.baselineDiff!.missingTables.length
          + status.baselineDiff!.columnProblems.length
          + status.baselineDiff!.missingConstraints.length
          + status.baselineDiff!.missingIndexes.length
          + status.baselineDiff!.missingTriggers.length,
        ).toBeGreaterThan(0);
      } finally {
        await client.end().catch(() => {});
      }
    });
  }

  it("الفروق التفصيلية مقروءة ومصنَّفة (describeBaselineDiff)", async () => {
    const { pool, client } = await withFreshP0Database("aqlan_p1_probe_describe");
    databases.push("aqlan_p1_probe_describe");
    try {
      await client.query(`ALTER TABLE payments DROP COLUMN note`);
      const status = await migrationStatus(pool, files);
      const { describeBaselineDiff } = await import("../../lib/baseline-probe");
      const lines = describeBaselineDiff(status.baselineDiff!);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).toMatch(/payments\.note/);
    } finally {
      await client.end().catch(() => {});
    }
  });

  it("adoption على قاعدة مهاجرة أصلًا (بعد التطبيق) — المجسّ ليس في وضع المقارنة", async () => {
    const url = await createIsolatedDatabase("aqlan_p1_probe_applied");
    databases.push("aqlan_p1_probe_applied");
    const client = new Client({ connectionString: url, ssl: false });
    await client.connect();
    try {
      const pool = clientAsPool(client);
      await migrate(pool, { apply: true, files });
      const status = await migrationStatus(pool, files);
      // الأساس مسجَّل: سلامة البصمات هي الحاكم — baselineDiff = null لا mismatch
      expect(status.baselineDiff).toBeNull();
      expect(status.consistent).toBe(true);
    } finally {
      await client.end().catch(() => {});
    }
  });
});

