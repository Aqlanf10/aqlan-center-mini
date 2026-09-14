import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();

const {
  addWaitingEntry, createPatient, ensureSchema, getPool,
  listWaitingEntries, resetPoolForTesting,
} = await import("../../lib/db");

/**
 * مريضٌ واحد لا ينتظر مرتين — على PostgreSQL حقيقيّ.
 *
 * كان الحارس فحصًا يسبق الإدراج: `SELECT` ثم `INSERT`. وموظّفتان تسجّلان المريض
 * نفسه في اللحظة نفسها تمرّان كلتاهما — كلٌّ قرأت قبل أن تكتب الأخرى. فيصير في
 * القائمة اسمٌ مكرَّر يُنادى مرتين ويُحتسب مرتين، ويُغلق أحدُهما فيبقى الآخر
 * معلّقًا بلا سبب يعرفه أحد.
 *
 * وهذا لا يُثبَت على PGlite: محرّكٌ باتصالٍ واحد، فالمعاملتان تتداخلان عليه
 * ويمحو تراجعُ إحداهما عمل الأخرى — سلوكُ المحاكي لا سلوكُ الإنتاج.
 *
 * والحارس الآن فهرسٌ فريدٌ جزئيّ في القاعدة: هي الحَكَم، لا ترتيبُ الاستعلامات.
 */

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 120_000);

afterAll(async () => {
  await resetPoolForTesting();
});

let seq = 0;
async function patient(): Promise<number> {
  seq += 1;
  const created = await createPatient({
    fullName: `منتظِر ${seq} ${Date.now()}`,
    phone: `73${String(Date.now() + seq).slice(-7)}`,
    altPhone: null, gender: "female", birthYear: 1995,
    address: null, medicalAlert: null, note: null,
  });
  return created.id;
}

const entry = (patientId: number) => ({
  patientId, preferredPeriod: "any" as const, urgency: "normal" as const,
});

const actor = { actor: "الاستقبال", actorRole: "reception" };

describe("تسجيلان متزامنان للمريض نفسه", () => {
  it("واحدٌ يُكتب والآخر يُردّ — وصفٌّ واحدٌ في القاعدة", async () => {
    const id = await patient();

    const [a, b] = await Promise.all([
      addWaitingEntry(entry(id), actor),
      addWaitingEntry(entry(id), { actor: "الاستقبال ٢", actorRole: "reception" }),
    ]);

    const succeeded = [a, b].filter((result) => result.ok);
    const refused = [a, b].filter((result) => !result.ok);
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);

    /* عددُ الصفوف هو الإثبات: نجاحان بصفٍّ واحد، أو نجاحٌ بصفّين، كلاهما عطب. */
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM waiting_list
        WHERE patient_id = $1 AND status IN ('waiting','offered')`,
      [id],
    );
    expect(rows[0].n).toBe(1);

    /* والرفض يقول للمستخدم ما حدث بالعربية، لا يصمت. */
    const message = refused[0].ok ? "" : refused[0].message;
    expect(message).toMatch(/[؀-ۿ]/);
  }, 60_000);

  it("ومريضان مختلفان يمرّان معًا — الحارس يمنع التكرار لا العمل", async () => {
    const [first, second] = [await patient(), await patient()];
    const [a, b] = await Promise.all([
      addWaitingEntry(entry(first), actor),
      addWaitingEntry(entry(second), actor),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  }, 60_000);

  it("ومن أُغلق انتظاره يستطيع الانتظار من جديد — الفهرس على المفتوحين وحدهم", async () => {
    const id = await patient();
    const first = await addWaitingEntry(entry(id), actor);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await getPool().query(
      `UPDATE waiting_list SET status = 'cancelled', resolved_at = NOW() WHERE id = $1`,
      [first.entry.id],
    );

    /* مريضٌ اعتذر ثم عاد بعد شهر ليس تكرارًا — ومنعُه يجعل القائمة تُغلق دونه. */
    const again = await addWaitingEntry(entry(id), actor);
    expect(again.ok).toBe(true);

    const open = await listWaitingEntries({});
    expect(open.filter((row) => row.patientId === id)).toHaveLength(1);
  }, 60_000);
});
