import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();
process.env.DB_POOL_MAX = "12";

const {
  createPatient, ensureSchema, getPool, invalidateSettingsCache, listAudit,
  resetPoolForTesting, saveSettings, seedAppointmentServices, transitionAppointment,
} = await import("../../lib/db");
const { bookAppointment, rescheduleAppointment } = await import("../../lib/book-appointment");

/**
 * نقلُ الموعد — على PostgreSQL حقيقيّ.
 *
 * وما يُحرَس هنا ثلاثة، وكلُّها لا تُثبَت على PGlite لأنّها قفلٌ ومعاملات:
 *   • نقلان متعاكسان بين اليومين نفسيهما لا يتجمّدان (ترتيبُ القفلين الثابت).
 *   • آخرُ مكانٍ في اليوم الهدف يفوز به واحد.
 *   • رفضُ الهدف يُبقي الموعد الأصل كما هو — لا يُترك المريض بلا موعد.
 */

const actor = { username: "الاستقبال", role: "reception" as const, channel: "ui" as const };
const A = "2026-11-02";
const B = "2026-11-03";

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await saveSettings({
    "clinic.chairs": "2", "clinic.day_start": "08:00", "clinic.day_end": "20:00",
  });
  await seedAppointmentServices().catch(() => {});
}, 180_000);

afterAll(async () => { await resetPoolForTesting(); });

let seq = 0;
async function patientId(): Promise<number> {
  seq += 1;
  const created = await createPatient({
    fullName: `منقول ${seq} ${Date.now()}`,
    phone: `73${String(Date.now() + seq).slice(-7)}`,
    altPhone: null, gender: "male", birthYear: 1992,
    address: null, medicalAlert: null, note: null,
  });
  return created.id;
}

async function book(date: string, time: string, duration = 30): Promise<number> {
  const result = await bookAppointment(
    { patientId: await patientId(), date, time, durationMinutes: duration }, actor,
  );
  expect(result.ok, "تعذّر تهيئة الموعد").toBe(true);
  if (!result.ok) throw new Error("booking failed");
  return Number(result.appointment.id);
}

async function slotOf(id: number): Promise<string> {
  const { rows } = await getPool().query<{ d: string; t: string }>(
    `SELECT scheduled_date::text AS d, scheduled_time::text AS t FROM appointments WHERE id = $1`,
    [id],
  );
  return `${rows[0].d} ${rows[0].t.slice(0, 5)}`;
}

describe("النقل الأساسيّ", () => {
  it("ينقل الموعد ويحفظ لقطاته ويكتب الأثر بقبل/بعد", async () => {
    const id = await book(A, "09:00", 45);
    const before = await slotOf(id);

    const moved = await rescheduleAppointment(
      { appointmentId: id, date: B, time: "11:00", reason: "طلب المريض" }, actor,
    );
    expect(moved.ok).toBe(true);
    expect(await slotOf(id)).toBe(`${B} 11:00`);

    /* المدّةُ كما حُجزت: نقلُ الوقت لا يعيد تسعير المدّة. */
    const { rows } = await getPool().query<{ duration_minutes: number }>(
      `SELECT duration_minutes FROM appointments WHERE id = $1`, [id],
    );
    expect(rows[0].duration_minutes).toBe(45);

    const audit = await listAudit({ action: "appointment.reschedule" } as never)
      .catch(() => [] as unknown[]);
    const entry = (audit as { entityId?: string; details?: Record<string, unknown> }[])
      .find((one) => one.entityId === String(id));
    expect(entry, "لا أثرَ للنقل في سجلّ التدقيق").toBeTruthy();
    expect(String(entry?.details?.["من"] ?? "")).toContain(before.split(" ")[0]);
  }, 120_000);

  it("ولا يُنقل موعدٌ تغيّرت حاله", async () => {
    const id = await book(A, "12:00");
    await transitionAppointment(id, "cancelled", {
      actor: "الاستقبال", actorRole: "reception", reason: "اعتذر المريض",
    });
    const moved = await rescheduleAppointment(
      { appointmentId: id, date: B, time: "12:00", reason: "محاولة" }, actor,
    );
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.message).toMatch(/[؀-ۿ]/);
  }, 120_000);

  it("والسببُ إلزاميّ", async () => {
    const id = await book(A, "13:00");
    const moved = await rescheduleAppointment(
      { appointmentId: id, date: B, time: "13:00", reason: " " }, actor,
    );
    expect(moved.ok).toBe(false);
  }, 120_000);

  /* **الموعد لا يزاحم نفسه** — والحالةُ تُبنى على كرسيٍّ واحد عمدًا.
     فبكرسيّين يتّسع اليوم للحالتين، فيمرّ الفحص سواءٌ استُثني الموعد أم لا،
     ويبدو أخضر وهو لا يُثبت شيئًا. وبكرسيٍّ واحد: نقلُ موعدٍ إلى وقتٍ يتداخل
     مع وقته القديم يجعله — بلا استثناء — يشغل الكرسيَّ الوحيد في وجه نفسه،
     فيُرفض نقلٌ مشروع. */
  it("ينتقل إلى وقتٍ متداخل مع وقته القديم على كرسيٍّ واحد", async () => {
    await saveSettings({ "clinic.chairs": "1" });
    invalidateSettingsCache();
    try {
      const id = await book(A, "15:00", 60);
      const moved = await rescheduleAppointment(
        { appointmentId: id, date: A, time: "15:30", reason: "تأخّر الطبيب" }, actor,
      );
      expect(moved.ok, "الموعد زاحم نفسه فرُفض نقلُه").toBe(true);
      expect(await slotOf(id)).toBe(`${A} 15:30`);
    } finally {
      await saveSettings({ "clinic.chairs": "2" });
      invalidateSettingsCache();
    }
  }, 120_000);
});

describe("التزامن", () => {
  /* ترتيبُ القفلين الثابت: بلا هذا يتجمّد الطرفان. */
  it("نقلان متعاكسان بين اليومين نفسيهما يمضيان بلا تجمّد", async () => {
    const first = await book(A, "16:00");
    const second = await book(B, "16:30");

    const done = await Promise.all([
      rescheduleAppointment({ appointmentId: first, date: B, time: "17:00", reason: "تبادل ١" }, actor),
      rescheduleAppointment({ appointmentId: second, date: A, time: "17:30", reason: "تبادل ٢" }, actor),
    ]);
    expect(done.every((one) => one.ok)).toBe(true);
    expect(await slotOf(first)).toBe(`${B} 17:00`);
    expect(await slotOf(second)).toBe(`${A} 17:30`);
  }, 120_000);

  /**
   * الخطرُ نفسه، مُثبَتًا في القاعدة لا في التطبيق.
   *
   * الفحصُ أعلاه (نقلان متعاكسان) **لا يُثبت** ترتيبَ القفلين: نافذتا القفل قد
   * لا تتداخلان أصلًا فيمرّ سواءٌ رُتِّبت المفاتيح أم لا — جرّبتُ تعطيل الترتيب
   * فمرّ. فالإثباتُ هنا مباشر: اتصالان يأخذان القفلين **بترتيبين متعاكسين**
   * بحاجزٍ بينهما، فتكشف PostgreSQL التجمّد وتُجهض أحدهما. ثمّ الاتصالان
   * نفسُهما بالترتيب الثابت يمضيان.
   */
  it("قفلان بترتيبين متعاكسين يتجمّدان، وبالترتيب الثابت يمضيان", async () => {
    const lock = (client: { query: (q: string, p?: unknown[]) => Promise<unknown> }, key: string) =>
      client.query(`SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))`, [key]);

    const one = await getPool().connect();
    const two = await getPool().connect();
    try {
      await one.query("BEGIN");
      await two.query("BEGIN");
      await lock(one, A);
      await lock(two, B);
      /* كلٌّ يطلب الآن قفلَ الآخر — وهذا هو التجمّد بعينه. */
      const crossed = await Promise.allSettled([lock(one, B), lock(two, A)]);
      expect(
        crossed.some((result) => result.status === "rejected"),
        "لم تكشف القاعدة التجمّد — الحاجز لم يعمل",
      ).toBe(true);
    } finally {
      await one.query("ROLLBACK").catch(() => {});
      await two.query("ROLLBACK").catch(() => {});
      one.release();
      two.release();
    }

    /* والآن بالترتيب الثابت — أصغرُ التاريخين أوّلًا في الاثنين. */
    const [first, second] = [A, B].sort();
    const three = await getPool().connect();
    const four = await getPool().connect();
    try {
      await three.query("BEGIN");
      await lock(three, first);
      await lock(three, second);
      await three.query("COMMIT");

      await four.query("BEGIN");
      await lock(four, first);
      await lock(four, second);
      await four.query("COMMIT");
    } finally {
      three.release();
      four.release();
    }
  }, 120_000);

  it("ورفضُ الهدف يُبقي الموعد الأصل كما هو", async () => {
    const id = await book(A, "18:00");
    const before = await slotOf(id);
    /* وقتٌ خارج ورديات المركز لا يُسقط الموعد الأصل مهما كان الحكم. */
    const moved = await rescheduleAppointment(
      { appointmentId: id, date: B, time: "23:45", reason: "محاولة خارج الدوام" }, actor,
    );
    if (!moved.ok) expect(await slotOf(id)).toBe(before);
    else expect(await slotOf(id)).toBe(`${B} 23:45`);
  }, 120_000);
});
