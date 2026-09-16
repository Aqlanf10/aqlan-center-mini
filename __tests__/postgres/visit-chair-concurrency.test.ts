import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();

const {
  addVisit, callVisit, ensureSchema, finishVisit, getPool, resetPoolForTesting,
  returnVisitToWaiting, seatVisit,
} = await import("../../lib/db");

/**
 * كرسيٌّ واحد ومريضان — على PostgreSQL حقيقيّ.
 *
 * الحارسُ في `seatVisit` و`callVisit` مكتوبٌ داخل جملة التحديث:
 * `UPDATE … WHERE status = … AND NOT EXISTS (SELECT 1 FROM visits busy …)`.
 * وهذا **ليس** الحارسَ نفسه الذي يحمي الحجز: هناك يقفل `writeAppointmentInDay`
 * اليومَ بقفلٍ صريح، أمّا هنا فالشرط يقرأ **صفوفًا أخرى** غير الصفّ الذي يُحدَّث.
 * وقراءةُ صفوفٍ أخرى داخل `UPDATE` لا يمنعها القفل — وهو ما يُسمّى انحرافَ
 * الكتابة (write skew): معاملتان تقرآن «الكرسي فارغ» في اللحظة نفسها، ثمّ تكتب
 * كلٌّ منهما صفَّها، فيُجلس مريضان على كرسيّ واحد.
 *
 * ولهذا لا يُثبت على PGlite: اتصالٌ واحد يُسلسل المعاملتين فيبدو الحارس سليمًا.
 *
 * وهذا الفحص **يفحص ولا يفترض**: إن لم يقع الانحراف فالتقرير يقول ذلك، وإن وقع
 * فهو عطبٌ يُصلَح. وفي كلتا الحالتين: **لا يجلس مريضان على كرسيّ واحد.**
 */

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 180_000);

afterAll(async () => { await resetPoolForTesting(); });

let seq = 0;
async function waitingVisit(): Promise<number> {
  seq += 1;
  const visit = await addVisit({
    patientName: `منتظِر الكرسي ${seq} ${Date.now()}`,
    patientPhone: null, note: null,
  });
  return visit.id;
}

/** من يشغل هذا الكرسي فعلًا الآن — الحكم في القاعدة لا في ردّ الدالّة. */
async function occupantsOf(chair: number): Promise<number[]> {
  const { rows } = await getPool().query<{ id: number }>(
    `SELECT id FROM visits
      WHERE chair = $1 AND status IN ('called', 'in_chair')
      ORDER BY id`,
    [chair],
  );
  return rows.map((row) => row.id);
}

describe("إجلاسان متزامنان على الكرسي نفسه", () => {
  it("مريضٌ واحد يجلس، والآخر يُردّ — ولا كرسيَّ يحمل اثنين", async () => {
    const [first, second] = [await waitingVisit(), await waitingVisit()];
    const chair = 1;

    const [a, b] = await Promise.all([
      seatVisit(first, chair),
      seatVisit(second, chair),
    ]);

    const seated = [a, b].filter((visit) => visit !== null);
    const occupants = await occupantsOf(chair);

    /* الإثباتُ في القاعدة: صفّان بالحالة `in_chair` على كرسيٍّ واحد عطبٌ ولو
       بدا الردّان سليمين. */
    expect(occupants).toHaveLength(1);
    expect(seated).toHaveLength(1);
  }, 120_000);

  it("نداءان متزامنان على الكرسي نفسه — واحدٌ يفوز", async () => {
    const [first, second] = [await waitingVisit(), await waitingVisit()];
    const chair = 2;

    await Promise.all([callVisit(first, chair), callVisit(second, chair)]);

    expect(await occupantsOf(chair)).toHaveLength(1);
  }, 120_000);

  it("نداءٌ وإجلاسٌ متزامنان على الكرسي نفسه — لا يجتمعان", async () => {
    const [first, second] = [await waitingVisit(), await waitingVisit()];
    const chair = 3;

    await Promise.all([callVisit(first, chair), seatVisit(second, chair)]);

    expect(await occupantsOf(chair)).toHaveLength(1);
  }, 120_000);

  /* والسلوك المشروع لا يُكسر: كرسيّان مختلفان يعملان معًا. */
  it("كرسيّان مختلفان يُجلسان مريضين في اللحظة نفسها", async () => {
    const [first, second] = [await waitingVisit(), await waitingVisit()];

    const [a, b] = await Promise.all([seatVisit(first, 7), seatVisit(second, 8)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await occupantsOf(7)).toHaveLength(1);
    expect(await occupantsOf(8)).toHaveLength(1);
  }, 120_000);

  /* والكرسيُّ يتحرّر فعلًا بعد الإنهاء — وإلّا صار الحارس قفلًا دائمًا. */
  it("الكرسيُّ يقبل مريضًا جديدًا بعد إنهاء من قبله", async () => {
    const first = await waitingVisit();
    const chair = 9;
    expect(await seatVisit(first, chair)).not.toBeNull();
    expect(await finishVisit(first)).not.toBeNull();

    const second = await waitingVisit();
    expect(await seatVisit(second, chair)).not.toBeNull();
    expect(await occupantsOf(chair)).toEqual([second]);
  }, 120_000);

  /* وإعادةُ المنادى عليه إلى الانتظار تُحرّر كرسيّه للمنادى التالي. */
  it("إعادةُ منادًى عليه إلى الانتظار تُحرّر كرسيّه", async () => {
    const first = await waitingVisit();
    const chair = 10;
    expect(await callVisit(first, chair)).not.toBeNull();
    expect(await returnVisitToWaiting(first)).not.toBeNull();

    const second = await waitingVisit();
    expect(await callVisit(second, chair)).not.toBeNull();
    expect(await occupantsOf(chair)).toEqual([second]);
  }, 120_000);
});
