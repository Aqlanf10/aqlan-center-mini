import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();

const {
  addWaitingEntry, createPatient, ensureSchema, getPool, getWaitingEntry,
  resetPoolForTesting, saveSettings,
} = await import("../../lib/db");
const { convertWaitingToAppointment } = await import("../../lib/waiting-list-booking");

/**
 * النافذة بين كتابة الموعد وإغلاق الصفّ — وتعافيها.
 *
 * التحويل ثلاث خطوات: مطالبة، ثمّ كتابةُ الموعد (تُثبَّت في معاملتها)، ثمّ إغلاق
 * الصفّ. والسقوطُ بين الثانية والثالثة — انقطاعُ شبكة، أو إعادةُ تشغيل، أو خطأٌ
 * عابر في القاعدة — كان يترك **موعدًا موجودًا وصفًّا مفتوحًا**. فتُعاد المحاولة
 * بعد دقيقتين (انتهاء المطالبة) فيُكتب للمريض **موعدٌ ثانٍ**، ويُقال له إنّ له
 * موعدين، ويُحجز كرسيّان لواحد.
 *
 * والفشلُ هنا **مفروضٌ فعلًا** لا محاكى: مُشغِّلٌ في القاعدة يرفع خطأً على أيّ
 * تحديثٍ يجعل الحالة «حُجز». فالخطوة الثالثة تسقط كما تسقط في الإنتاج، ويبقى ما
 * قبلها مثبَّتًا كما يبقى.
 *
 * وهذا لا يُثبَت على PGlite: المُشغِّل والمعاملات والفهرسُ الفريد الجزئيّ سلوكُ
 * قاعدةٍ حقيقية.
 */

const actor = { actor: "الاستقبال", actorRole: "reception" };
const staff = { username: "الاستقبال", role: "reception" as const, channel: "ui" as const };

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await saveSettings({
    "clinic.chairs": "2", "clinic.day_start": "09:00", "clinic.day_end": "21:00",
  });
}, 180_000);

afterAll(async () => {
  await getPool().query(
    `DROP TRIGGER IF EXISTS waiting_finalize_fault ON waiting_list`,
  ).catch(() => {});
  await getPool().query(`DROP FUNCTION IF EXISTS waiting_finalize_fault()`).catch(() => {});
  await resetPoolForTesting();
});

let seq = 0;
async function patient(): Promise<number> {
  seq += 1;
  const created = await createPatient({
    fullName: `منتظِر تعافٍ ${seq} ${Date.now()}`,
    phone: `73${String(Date.now() + seq).slice(-7)}`,
    altPhone: null, gender: "male", birthYear: 1990,
    address: null, medicalAlert: null, note: null,
  });
  return created.id;
}

/** يُسقط الخطوة الثالثة وحدها: أيُّ تحديثٍ يجعل الحالة «حُجز» يرفع خطأً. */
async function installFault(): Promise<void> {
  await getPool().query(`
    CREATE OR REPLACE FUNCTION waiting_finalize_fault() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.status = 'booked' THEN
        RAISE EXCEPTION 'عطبٌ مفروض: سقوط إغلاق صفّ الانتظار بعد كتابة الموعد';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await getPool().query(`
    CREATE TRIGGER waiting_finalize_fault
      BEFORE UPDATE ON waiting_list
      FOR EACH ROW EXECUTE FUNCTION waiting_finalize_fault();
  `);
}

async function removeFault(): Promise<void> {
  await getPool().query(`DROP TRIGGER IF EXISTS waiting_finalize_fault ON waiting_list`);
}

async function appointmentsFor(patientId: number): Promise<number[]> {
  const { rows } = await getPool().query<{ id: number }>(
    `SELECT id FROM appointments WHERE patient_id = $1 ORDER BY id`, [patientId],
  );
  return rows.map((row) => row.id);
}

describe("سقوطُ إغلاق الصفّ بعد كتابة الموعد", () => {
  it("إعادةُ المحاولة تربط الموعد نفسه — موعدٌ واحد لا موعدان", async () => {
    const patientId = await patient();
    const created = await addWaitingEntry(
      { patientId, preferredPeriod: "any", urgency: "normal" }, actor,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const waitingId = created.entry.id;

    /* ١) المحاولة الأولى: الموعد يُكتب، ثمّ يسقط الإغلاق فعلًا. */
    await installFault();
    await expect(convertWaitingToAppointment(
      { waitingId, date: "2026-05-04", time: "10:00", durationMinutes: 30 }, staff,
    )).rejects.toThrow();

    /* ٢) الحال بعد السقوط: موعدٌ **موجود** وصفٌّ **مفتوح** — وهي الحال التي
       كانت تُنتج الموعد الثاني. والموعد موسومٌ برقم صفّه. */
    const afterFault = await appointmentsFor(patientId);
    expect(afterFault).toHaveLength(1);

    const stillOpen = await getWaitingEntry(waitingId);
    expect(stillOpen?.status).toBe("waiting");
    expect(stillOpen?.appointmentId ?? null).toBeNull();

    const { rows: [tagged] } = await getPool().query<{ waiting_list_id: number | null }>(
      `SELECT waiting_list_id FROM appointments WHERE id = $1`, [afterFault[0]],
    );
    expect(tagged.waiting_list_id).toBe(waitingId);

    /* ٣) يزول العطب، وتُعاد المحاولة — كما يضغط الموظّف ثانيةً. */
    await removeFault();
    const retry = await convertWaitingToAppointment(
      { waitingId, date: "2026-05-04", time: "11:30", durationMinutes: 30 }, staff,
    );
    expect(retry.ok).toBe(true);

    /* ٤) الحكم: موعدٌ واحد في القاعدة — **وهو الأوّل** لا موعدٌ جديد في ١١:٣٠.
       فإعادةُ المحاولة وجدت المكتوب وربطته، ولم تكتب للمريض موعدًا ثانيًا. */
    const afterRetry = await appointmentsFor(patientId);
    expect(afterRetry).toEqual(afterFault);
    if (retry.ok && retry.appointment) expect(retry.appointment.id).toBe(afterFault[0]);

    const linked = await getWaitingEntry(waitingId);
    expect(linked?.status).toBe("booked");
    expect(linked?.appointmentId).toBe(afterFault[0]);
  }, 120_000);

  /* والحارس الأخير في القاعدة لا في ترتيب الاستدعاءات: لو تسلّل مسارٌ ما وحاول
     كتابة موعدٍ ثانٍ لصفٍّ له موعد، ترفضه القاعدة نفسها. */
  it("القاعدةُ ترفض موعدًا ثانيًا لصفّ انتظارٍ واحد", async () => {
    const patientId = await patient();
    const created = await addWaitingEntry(
      { patientId, preferredPeriod: "any", urgency: "normal" }, actor,
    );
    if (!created.ok) return;
    const waitingId = created.entry.id;

    const booked = await convertWaitingToAppointment(
      { waitingId, date: "2026-05-05", time: "10:00", durationMinutes: 30 }, staff,
    );
    expect(booked.ok).toBe(true);

    await expect(getPool().query(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status, waiting_list_id)
       VALUES ($1, '2026-05-05', '12:00', 30, 'booked', $2)`,
      [patientId, waitingId],
    )).rejects.toThrow();

    expect(await appointmentsFor(patientId)).toHaveLength(1);
  }, 120_000);

  /* وإعادةُ الضغط على صفٍّ أُغلق سلفًا تعيد الموعد نفسه — لا موعدًا ثانيًا ولا خطأً. */
  it("الضغطةُ الثالثة بعد التعافي لا تُنتج شيئًا جديدًا", async () => {
    const patientId = await patient();
    const created = await addWaitingEntry(
      { patientId, preferredPeriod: "any", urgency: "normal" }, actor,
    );
    if (!created.ok) return;
    const waitingId = created.entry.id;

    const first = await convertWaitingToAppointment(
      { waitingId, date: "2026-05-06", time: "10:00", durationMinutes: 30 }, staff,
    );
    expect(first.ok).toBe(true);
    const ids = await appointmentsFor(patientId);

    const again = await convertWaitingToAppointment(
      { waitingId, date: "2026-05-06", time: "13:00", durationMinutes: 30 }, staff,
    );
    expect(again.ok).toBe(true);
    expect(await appointmentsFor(patientId)).toEqual(ids);
  }, 120_000);
});
