import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * مراجعة: نقل موعدٍ ذُكِّر به يمحو ختم التذكير وتأكيد المريض — كلاهما كان عن الوقت القديم.
 * وإلا خرج الموعد المنقول من فلتر «لم يُذكَّر» والمريض لم يعرف بوقته الجديد.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, moveAppointmentOnClient } = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

afterAll(async () => {
  await resetPoolForTesting();
});

async function reminded(time: string): Promise<number> {
  const pool = getPool();
  const { rows: [patient] } = await pool.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض النقل') RETURNING id`, [`MV-${time}`],
  );
  const { rows: [appointment] } = await pool.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, status, reminder_sent_at, patient_confirmed_at)
     VALUES ($1, '2031-05-10', $2, 'booked', NOW(), NOW()) RETURNING id`, [patient.id, time],
  );
  return appointment.id;
}

async function move(id: number, fromTime: string, toDate: string, toTime: string) {
  // The production writer receives one checked-out transaction client. Preserve
  // that contract here, including row locks held between separate statements.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await moveAppointmentOnClient(client, {
      id, fromDate: "2031-05-10", fromTime, toDate, toTime, durationMinutes: 30, serviceId: null,
      appointmentType: null, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, occupiesChair: true, chairNo: null, doctorId: null,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("نقل الموعد وختم التذكير", () => {
  it("نقلٌ إلى وقتٍ آخر يمحو ختم التذكير وتأكيد المريض", async () => {
    const id = await reminded("10:00");
    const moved = await move(id, "10:00", "2031-05-12", "11:30");
    expect(moved?.reminderSentAt ?? null).toBeNull();
    const { rows: [row] } = await getPool().query<{ confirmed: string | null }>(
      `SELECT patient_confirmed_at::text AS confirmed FROM appointments WHERE id = $1`, [id],
    );
    expect(row.confirmed).toBeNull();
  });

  it("تعديلٌ لا يغيّر اليوم ولا الساعة يُبقي الختمين", async () => {
    const id = await reminded("13:00");
    const moved = await move(id, "13:00", "2031-05-10", "13:00");
    expect(moved?.reminderSentAt).toBeTruthy();
  });
});
