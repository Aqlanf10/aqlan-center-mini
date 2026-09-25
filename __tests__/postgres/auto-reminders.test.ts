import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/** (P2-12) التذكير الآلي على PostgreSQL 18: لا تذكيران، ولا جولتان معًا. */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, createPatient, markReminderSentIfPending, markReminderSent, withAutoReminderLock } =
  await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});
afterAll(async () => { await resetPoolForTesting(); });

describe("auto reminders", () => {
  it("marks once — a manual reminder that came first is not overwritten", async () => {
    const patient = await createPatient({
      fullName: "مريض التذكير", phone: "771000001", altPhone: null, gender: "unknown", birthYear: null,
      address: null, medicalAlert: null, note: null,
    });
    const { rows: [appointment] } = await getPool().query<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time) VALUES ($1, CURRENT_DATE + 1, '10:00') RETURNING id`,
      [patient.id],
    );
    expect(await markReminderSentIfPending(appointment.id)).toBe(true);
    const { rows: [first] } = await getPool().query<{ at: string }>(`SELECT reminder_sent_at::text AS at FROM appointments WHERE id = $1`, [appointment.id]);
    expect(await markReminderSentIfPending(appointment.id)).toBe(false);
    const { rows: [second] } = await getPool().query<{ at: string }>(`SELECT reminder_sent_at::text AS at FROM appointments WHERE id = $1`, [appointment.id]);
    expect(second.at).toBe(first.at);
    // والمسار اليدوي كما كان.
    expect(await markReminderSent(appointment.id)).toBe(true);
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
