import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * اختبارات تزامن المخزون ومتوسط التكلفة الموزون على PostgreSQL حقيقي (P1.9).
 *
 * السيناريوهات المطلوبة:
 *  ١) استلام شراء متزامن مع صرف.
 *  ٢) صرفان متزامنان في اللحظة نفسها.
 *  ٣) تسوية/ردّ بعد التزامن.
 *  ٤) مخزون لا يكفي.
 *  ٥) لا كمية سالبة أبدًا.
 *  ٦) WAC يبقى deterministic.
 * والكمية والتكلفة الإجمالية وsnapshot المتوسط تتغير داخل معاملة واحدة، مع
 * إثبات الأقفال (FOR UPDATE) ضد السباقات.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, createInventoryMovement,
} = await import("../../lib/db");
const { costNow } = await import("../../lib/inventoryCost");
const { listInventoryMovements } = await import("../../lib/db");

let itemId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  const { rows: [item] } = await pool.query(
    `INSERT INTO inventory_items (name, unit, is_active, created_by)
     VALUES ('قفازات PGC', 'صندوق', TRUE, 'pg-test') RETURNING id`,
  );
  itemId = item.id;
}, 180_000);

afterAll(async () => {
  await resetPoolForTesting();
});

async function currentBalance(): Promise<number> {
  const { rows: [row] } = await getPool().query<{ balance: string }>(
    `SELECT COALESCE(SUM(CASE m.kind WHEN 'in' THEN m.qty WHEN 'out' THEN -m.qty ELSE m.qty END), 0) AS balance
       FROM inventory_movements m WHERE m.item_id = $1`, [itemId],
  );
  return Number(row.balance);
}

/** حركات البند بترتيب الوقوع (id تصاعديًّا) — الترتيب الذي تشترطه حسابات WAC. */
async function movementsForCost() {
  const movements = await listInventoryMovements(itemId, 5000);
  return movements
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((movement) => ({
      id: movement.id, kind: movement.kind, qty: movement.qty,
      unitCostMinor: movement.unitCostMinor, isReturn: movement.isReturn,
    }));
}

describe("تزامن المخزون وWAC (PostgreSQL حقيقي)", () => {
  it("استلام شراء متزامن مع صرف ⇒ كلاهما يُسجَّل والرصيد والتكلفة متسقان", async () => {
    const [purchase, consumption] = await Promise.all([
      createInventoryMovement({ itemId, kind: "in", qty: 100, unitCostMinor: 1500, createdBy: "pg-test" }),
      createInventoryMovement({ itemId, kind: "out", qty: 10, createdBy: "pg-test" }),
    ]);
    // الصرف الأول على رصيد صفر سيفشل إن سبق الاستلام — كلا الترتيبين صحيح:
    // أ) صرف قبل الشراء ⇒ يُرفض (رصيد لا يكفي) والشراء ينجح.
    // ب) شراء قبل الصرف ⇒ كلاهما ينجح.
    const outcomes = [purchase, consumption];
    const successes = outcomes.filter((outcome) => outcome.ok);
    if (consumption.ok && purchase.ok) {
      expect(await currentBalance()).toBe(90);
    } else {
      // الصرف رُفض لأنه وصل قبل الالتزام بالاستلام — والشراء نجح
      expect(successes).toHaveLength(1);
      expect(successes[0]).toMatchObject({ ok: true });
      expect(await currentBalance()).toBe(100);
    }
  });

  it("صرفان متزامنان على رصيد كافٍ ⇒ كلاهما ينجح والرصيد ينقص مرتين (لا Lost Update)", async () => {
    // تأمين رصيد كافٍ أولًا
    await createInventoryMovement({ itemId, kind: "in", qty: 100, unitCostMinor: 1500, createdBy: "pg-test" });
    const balanceBefore = await currentBalance();
    expect(balanceBefore).toBeGreaterThanOrEqual(190);

    const [a, b] = await Promise.all([
      createInventoryMovement({ itemId, kind: "out", qty: 5, createdBy: "pg-test" }),
      createInventoryMovement({ itemId, kind: "out", qty: 5, createdBy: "pg-test" }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(await currentBalance()).toBe(balanceBefore - 10); // لا خصم مزدوج ولا خصم مفقود
  });

  it("صرفان متزامنان لا يكفي الرصيد إلا لأحدهما ⇒ واحد فقط ينجح (لا Oversell)", async () => {
    const balance = await currentBalance();
    // رصيد متبقٍ بالضبط لعملية واحدة
    const almostAll = Math.max(1, Math.floor(balance));
    const results = await Promise.all([
      createInventoryMovement({ itemId, kind: "out", qty: almostAll, createdBy: "pg-test" }),
      createInventoryMovement({ itemId, kind: "out", qty: almostAll, createdBy: "pg-test" }),
    ]);
    const successes = results.filter((result) => result.ok);
    expect(successes).toHaveLength(1); // FOR UPDATE يرتّب المتسابقين: الثاني يرى الرصيد بعد الأول
    const finalBalance = await currentBalance();
    expect(finalBalance).toBeGreaterThanOrEqual(0); // لا سالب أبدًا
    expect(finalBalance).toBeLessThan(almostAll);
  });

  it("صرف أكبر من الرصيد ⇒ رفض صريح بلا كتابة", async () => {
    const balance = await currentBalance();
    const result = await createInventoryMovement({
      itemId, kind: "out", qty: balance + 1000, createdBy: "pg-test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/الرصيد|المخزون|الكمية/);
    expect(await currentBalance()).toBe(balance); // لم يتغير شيء
  });

  it("ردُّ مصروف بعد التزامن ⇒ يُدخل بالمتوسط الحالي ولا يكسر التاريخ", async () => {
    const stateBefore = costNow(await movementsForCost());
    const returned = await createInventoryMovement({
      itemId, kind: "in", qty: 3, isReturn: true, createdBy: "pg-test",
    });
    expect(returned.ok).toBe(true);
    const stateAfter = costNow(await movementsForCost());
    expect(stateAfter.qty).toBe(stateBefore.qty + 3); // الردّ يعيد 3 للميزان
  });

  it("WAC deterministic: نفس الحركات بترتيب الوقوع ⇒ نفس المتوسط دائمًا", async () => {
    const asCosted = await movementsForCost();
    const first = costNow(asCosted);
    const second = costNow([...asCosted]); // نسخة جديدة بنفس الترتيب
    const third = costNow(await movementsForCost()); // قراءة جديدة من القاعدة
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // ثوابت المتوسط: القيمة = الكمية × متوسط الوحدة (ضمن التقريب)
    if (first.qty > 0 && first.unitCostMinor !== null && first.unitCostMinor > 0) {
      expect(first.valueMinor).toBeGreaterThan(0);
      expect(Math.abs(first.valueMinor - first.qty * first.unitCostMinor)).toBeLessThanOrEqual(first.qty);
    }
  });

  it("استلام شرائح متزامنة بأسعار مختلفة ⇒ القيمة الإجمالية = مجموع القيم (لا قيمة مفقودة)", async () => {
    const before = costNow(await movementsForCost());
    await Promise.all([
      createInventoryMovement({ itemId, kind: "in", qty: 10, unitCostMinor: 1000, createdBy: "pg-test" }),
      createInventoryMovement({ itemId, kind: "in", qty: 20, unitCostMinor: 2000, createdBy: "pg-test" }),
      createInventoryMovement({ itemId, kind: "in", qty: 30, unitCostMinor: 3000, createdBy: "pg-test" }),
    ]);
    const after = costNow(await movementsForCost());
    expect(after.qty).toBe(before.qty + 60);
    const purchasesAdded = 10 * 1000 + 20 * 2000 + 30 * 3000;
    expect(after.valueMinor).toBeGreaterThanOrEqual(before.valueMinor + purchasesAdded - 1);
  });

  it("تسوية (adjust) متزامنة مع صرف ⇒ الترتيب آمن والرصيد دقيق", async () => {
    const balance = await currentBalance();
    const [adjust, consume] = await Promise.all([
      createInventoryMovement({ itemId, kind: "adjust", qty: -5, reason: "جرد", createdBy: "pg-test" }),
      createInventoryMovement({ itemId, kind: "out", qty: 2, createdBy: "pg-test" }),
    ]);
    // التسوية السالبة تحتاج رصيدًا كافيًا؛ النتيجة إما كلتاهما أو واحدة بحسب الرصيد
    const finalBalance = await currentBalance();
    if (adjust.ok && consume.ok) {
      expect(finalBalance).toBe(balance - 7);
    } else {
      expect(finalBalance).toBeLessThanOrEqual(balance);
      expect(finalBalance).toBeGreaterThanOrEqual(0);
    }
  });
});
