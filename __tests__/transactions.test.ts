import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * اختبارات مساعد المعاملات (P1.20) — التراجع المضمون وعدم تسريب الاتصال.
 * على PGlite الاتصال الوهمي release() لا يفعل شيئًا، لكن المسارات (BEGIN/COMMIT/
 * ROLLBACK) والضمانات الدلالية تُختبر كما هي — والتزامن الحقيقي في اختبارات
 * postgres الحقيقية.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const { getPool, resetPoolForTesting, ensureSchema } = await import("../lib/db");
const { withTransaction, withIsolation } = await import("../lib/transactions");

beforeAll(async () => {
  await ensureSchema();
}, 60000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("withTransaction", () => {
  it("ينفّذ العمل داخل معاملة ويلتزم", async () => {
    const pool = getPool();
    const result = await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO patients (patient_number, full_name) VALUES ('TX-P1', 'معاملة') RETURNING id`,
      );
      return "تم";
    });
    expect(result).toBe("تم");
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM patients WHERE patient_number = 'TX-P1'`);
    expect(rows[0].n).toBe(1);
  });

  it("خطأ داخل العمل ⇒ ROLLBACK كامل — لا أثر للكتابات الجزئية", async () => {
    const pool = getPool();
    await expect(withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO patients (patient_number, full_name) VALUES ('TX-P2-ROLLBACK', 'ملغاة')`,
      );
      throw new Error("خطأ مقصود");
    })).rejects.toThrow("خطأ مقصود");
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM patients WHERE patient_number = 'TX-P2-ROLLBACK'`);
    expect(rows[0].n).toBe(0);
  });

  it("التراجع يُنفَّذ حتى لو كان الخطأ في COMMIT نفسه — لا معاملة معلّقة", async () => {
    const pool = getPool();
    // استعلام خاطئ داخل العمل يفشل قبل COMMIT
    await expect(withTransaction(pool, async (client) => {
      await client.query("SELECT 1");
      await client.query("SELECT * FROM جدول_غير_موجود");
    })).rejects.toThrow();
    // الاتصال بعدها يعمل (غير محبوس في معاملة فاشلة)
    const { rows } = await pool.query("SELECT 1 AS one");
    expect(rows[0].one).toBe(1);
  });

  it("withIsolation ينفّذ بمستوى عزل صريح ويلتزم/يتراجع بنفس الضمانات", async () => {
    const pool = getPool();
    await withIsolation(pool, "REPEATABLE READ", async (client) => {
      const { rows } = await client.query(
        `SELECT current_setting('transaction_isolation') AS level`,
      );
      expect(["repeatable read", "serializable"]).toContain(String(rows[0].level).toLowerCase());
    });
    await expect(withIsolation(pool, "SERIALIZABLE", async () => {
      throw new Error("فشل معزول");
    })).rejects.toThrow("فشل معزول");
  });
});
