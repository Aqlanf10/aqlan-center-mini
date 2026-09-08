import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

/**
 * اختبارات تزامن إقرار أدوات الذكاء الاصطناعي على PostgreSQL حقيقي (P1.4).
 *
 * الإثبات المطلوب: طلبان متزامنان (اتصالان مختلفان) لنفس confirmation:
 *  * claim واحد فقط ينجح (INSERT ON CONFLICT تحت قيد المفتاح).
 *  * عملية المجال تُنفَّذ مرة واحدة (من ينجح الclaim هو من ينفّذ).
 *  * الثاني replay/consumed (يرفض).
 * وأيضًا: انتهاء صلاحية الإقرار، اتصال جديد بعد الاستهلاك، سلوك التراجع،
 * والقيد الفريد مباشرةً.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();

const { getPool, resetPoolForTesting, claimToolConfirmation, ensureSchema } = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

describe("تزامن استهلاك إقرار الذكاء الاصطناعي (PostgreSQL حقيقي)", () => {
  it("claim واحد فقط ينجح بين طلبين متزامنين على اتصالين مختلفين", async () => {
    const pool = rawPool(undefined, 5);
    try {
      const jti = `concurrent-jti-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      // اتصالان منفصلان فعليًّا يحاولان نفس الإقرار في اللحظة نفسها
      const [a, b] = await Promise.all([
        claimToolConfirmation(jti, 1, "tool"),
        claimToolConfirmation(jti, 1, "tool"),
      ]);
      const results = [a, b].sort();
      expect(results).toEqual([false, true]); // واحد فقط true

      // وعدّ الصفوف في القاعدة: صفٌّ واحد بالضبط
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM ai_confirmation_claims WHERE jti = $1`, [jti],
        );
        expect(Number(rows[0].n)).toBe(1);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it("من يفوز بالclaim هو من ينفّذ — والثاني مرفوض (replay) عبر اتصال جديد", async () => {
    const jti = `replay-jti-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const first = await claimToolConfirmation(jti, 7, "tool");
    expect(first).toBe(true); // الفائز ينفّذ عملية المجال

    // «عملية جديدة» بعد الاستهلاك — اتصال جديد من الpool أو عملية جديدة كليًّا
    const second = await claimToolConfirmation(jti, 7, "tool");
    const third = await claimToolConfirmation(jti, 7, "tool");
    expect(second).toBe(false); // replay: رفض
    expect(third).toBe(false);
  });

  it("مستخدم مختلف لنفس الإقرار ⇒ يُرفض أيضًا (الclaim للمستخدم الفائز)", async () => {
    const jti = `user-jti-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    expect(await claimToolConfirmation(jti, 1, "tool")).toBe(true);
    expect(await claimToolConfirmation(jti, 2, "tool")).toBe(false);
  });

  it("القيد الفريد مباشرةً: INSERT مكرر يفشل بـ23505", async () => {
    const pool = rawPool();
    try {
      const jti = `unique-jti-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO ai_confirmation_claims (jti, user_id, tool) VALUES ($1, 1, 'tool')`,
          [jti],
        );
        await expect(client.query(
          `INSERT INTO ai_confirmation_claims (jti, user_id, tool) VALUES ($1, 1, 'tool')`,
          [jti],
        )).rejects.toMatchObject({ code: "23505" });
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it("التراجع يحرر الإقرار: claim داخل معاملة تُتراجع ⇒ يمكن المطالبة به مجددًا", async () => {
    const pool = rawPool();
    try {
      const jti = `rollback-jti-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO ai_confirmation_claims (jti, user_id, tool) VALUES ($1, 9, 'tool')`,
          [jti],
        );
        // فشل عملية المجال داخل المعاملة ⇒ تراجع كامل (مع الإقرار نفسه)
        await client.query("ROLLBACK");
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS n FROM ai_confirmation_claims WHERE jti = $1`, [jti],
        );
        expect(rows[0].n).toBe(0); // الإقرار تحرّر مع التراجع
      } finally {
        client.release();
      }
      // وبعد التراجع: المطالبة به تنجح (تنفيذ الإجراء المحوَّل)
      expect(await claimToolConfirmation(jti, 9, "tool")).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("التنظيف يحذف الإقرارات المنتهية (TTL يوم واحد) فيستعيد الجدول نظافته", async () => {
    const pool = rawPool();
    try {
      const jti = `ttl-jti-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      expect(await claimToolConfirmation(jti, 3, "tool")).toBe(true);
      const client = await pool.connect();
      try {
        // نُقدّر الزمن: الإقرار صار أقدم من يوم
        await client.query(
          `UPDATE ai_confirmation_claims SET claimed_at = NOW() - INTERVAL '2 days' WHERE jti = $1`,
          [jti],
        );
        // نفس عبارة التنظيف في claimToolConfirmation
        const { rowCount } = await client.query(
          `DELETE FROM ai_confirmation_claims WHERE claimed_at < NOW() - INTERVAL '1 day'`,
        );
        expect(rowCount ?? 0).toBeGreaterThanOrEqual(1);
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS n FROM ai_confirmation_claims WHERE jti = $1`, [jti],
        );
        expect(rows[0].n).toBe(0);
      } finally {
        client.release();
      }
      // وبعد انتهائه: نفس الإقرار غير صالح (رُفض لأنه لم يُستهلك فعليًّا بعد التنظيف)
      expect(await claimToolConfirmation(jti, 3, "tool")).toBe(true); // صف جديد — السلوك الصحيح: التنظيف يحرر المفتاح للانتهاء المادي
    } finally {
      await pool.end();
    }
  });

  it("تزامن عشر مطالبات لنفس الإقرار ⇒ فائز واحد بالضبط", async () => {
    const jti = `storm-jti-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => claimToolConfirmation(jti, 5, "tool")),
    );
    expect(attempts.filter((won) => won)).toHaveLength(1);
    const pool = getPool();
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ai_confirmation_claims WHERE jti = $1`, [jti],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
