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

/** (Dot R1) Scripted client: each failure path decides reuse vs destruction exactly. */
describe("transaction cleanup on uncertain outcomes", () => {
  type Step = "BEGIN" | "COMMIT" | "ROLLBACK" | "WORK";
  function scripted(fail: Partial<Record<Step, Error>>) {
    const sql: string[] = [];
    const release = vi.fn();
    const client = {
      release,
      query: vi.fn(async (text: string) => {
        sql.push(text);
        const step: Step = text.startsWith("BEGIN") ? "BEGIN" : text === "COMMIT" ? "COMMIT" : text === "ROLLBACK" ? "ROLLBACK" : "WORK";
        if (fail[step]) throw fail[step];
        return { rows: [], rowCount: 0 };
      }),
    };
    const pool = { connect: vi.fn(async () => client), query: vi.fn() };
    return { pool: pool as never, sql, release };
  }
  const run = (pool: never, level?: "SERIALIZABLE") => level
    ? withIsolation(pool, level, async c => { await c.query("SELECT 1"); return "ok"; })
    : withTransaction(pool, async c => { await c.query("SELECT 1"); return "ok"; });

  it("clean COMMIT returns the result and recycles the client", async () => {
    const s = scripted({});
    await expect(run(s.pool)).resolves.toBe("ok");
    expect(s.sql).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.release).toHaveBeenCalledWith();
  });
  it("work failure with a confirmed ROLLBACK recycles; the original error propagates", async () => {
    const s = scripted({ WORK: new Error("work failed") });
    await expect(run(s.pool)).rejects.toThrow("work failed");
    expect(s.sql).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
    expect(s.release).toHaveBeenCalledWith();
  });
  it("work failure plus failed ROLLBACK destroys the client and keeps the original error", async () => {
    const s = scripted({ WORK: new Error("work failed"), ROLLBACK: new Error("socket closed") });
    await expect(run(s.pool)).rejects.toThrow("work failed");
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.release).toHaveBeenCalledWith(true);
  });
  for (const level of [undefined, "SERIALIZABLE"] as const) {
    it(`COMMIT failure never yields a result${level ? " (withIsolation)" : ""}; destroyed when cleanup is uncertain`, async () => {
      const lost = scripted({ COMMIT: new Error("connection lost during COMMIT"), ROLLBACK: new Error("connection lost") });
      await expect(run(lost.pool, level)).rejects.toThrow("connection lost during COMMIT");
      expect(lost.release).toHaveBeenCalledWith(true);
      const refused = scripted({ COMMIT: new Error("could not serialize access") });
      await expect(run(refused.pool, level)).rejects.toThrow("could not serialize access");
      // A confirmed ROLLBACK proves the CONNECTION is clean, not that nothing committed.
      expect(refused.release).toHaveBeenCalledWith();
    });
  }
  it("BEGIN failure never runs work and destroys the client", async () => {
    const s = scripted({ BEGIN: new Error("connection reset") });
    const work = vi.fn();
    await expect(withTransaction(s.pool, work)).rejects.toThrow("connection reset");
    expect(work).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledWith(true);
  });
});
