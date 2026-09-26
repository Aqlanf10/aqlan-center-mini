import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/** (P2-12) التذكير الآلي على PostgreSQL 18: لا تذكيران، ولا جولتان معًا. */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, createPatient, claimAutoReminder, releaseAutoReminder, markReminderSent, withAutoReminderLock } =
  await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});
afterAll(async () => { await resetPoolForTesting(); });

describe("auto reminders", () => {
  it("(review) claims the exact appointment version before sending — once, and never over a manual reminder or a move", async () => {
    const patient = await createPatient({
      fullName: "مريض التذكير", phone: "771000001", altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    const { rows: [row] } = await getPool().query<{ id: number; d: string; t: string }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time) VALUES ($1, CURRENT_DATE + 1, '10:00')
       RETURNING id, scheduled_date::text AS d, to_char(scheduled_time, 'HH24:MI') AS t`,
      [patient.id],
    );
    const version = { id: row.id, scheduledDate: row.d, scheduledTime: row.t };
    const token = await claimAutoReminder(version);
    expect(token).not.toBeNull();
    expect(await claimAutoReminder(version)).toBeNull();

    // الإرسال فشل ⇒ يُعاد الموعد كما كان، ويمكن ادعاؤه ثانية.
    await releaseAutoReminder(row.id, token!);
    const again = await claimAutoReminder(version);
    expect(again).not.toBeNull();
    await releaseAutoReminder(row.id, again!);

    // الموظفة ذكّرته يدويًّا ⇒ لا ادعاء؛ وتحرير ادعاءٍ قديم لا يمحو تذكيرها.
    expect(await markReminderSent(row.id)).toBe(true);
    expect(await claimAutoReminder(version)).toBeNull();
    await releaseAutoReminder(row.id, again!);
    const { rows: [manual] } = await getPool().query<{ at: string | null }>(`SELECT reminder_sent_at::text AS at FROM appointments WHERE id = $1`, [row.id]);
    expect(manual.at).not.toBeNull();

    // نُقل الموعد ⇒ النسخة القديمة لا تُدّعى.
    await getPool().query(`UPDATE appointments SET reminder_sent_at = NULL, scheduled_time = '12:00' WHERE id = $1`, [row.id]);
    expect(await claimAutoReminder(version)).toBeNull();
    expect(await claimAutoReminder({ ...version, scheduledTime: "12:00" })).not.toBeNull();
  });

  it("two rounds at once: the second is busy, and the lock is released afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withAutoReminderLock(async () => { await gate; return "first"; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await withAutoReminderLock(async () => "second")).toEqual({ busy: true });
    release();
    expect(await first).toEqual({ busy: false, result: "first" });
    expect(await withAutoReminderLock(async () => "third")).toEqual({ busy: false, result: "third" });
  });
});
