import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (LIVE-4) مريضٌ واحد لا يظهر مرتين في طابور اليوم.
 *
 * كان «وصل مريض» (زيارة مشي بملفٍّ مختار) يُنشئ زيارةً جديدة ولو كان المريض ينتظر أو
 * مُنادًى أو على الكرسي، و«وصل» على موعده يُنشئ ثانيةً وهو في الصالة أصلًا، وجهازان
 * يضغطان معًا يُنشئان اثنتين. الآن: زيارة المشي تُرفض بخطأٍ مسمّى يحمل الزيارة القائمة،
 * ووصول الموعد يُلحق الموعد بزيارته القائمة — والقفل لكل مريضٍ في اليوم يُسلسل المتزامنين.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  addVisit, arriveAppointment, finishVisit, ensureSchema, getPool, resetPoolForTesting, ActiveVisitExists,
} = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

let seq = 0;
async function patient(): Promise<{ id: number; name: string }> {
  seq += 1;
  const name = `مريض الطابور ${seq}`;
  const { rows: [row] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`DUP-${seq}`, name]);
  return { id: row.id, name };
}

async function bookToday(patientId: number): Promise<number> {
  const { rows: [row] } = await getPool().query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time)
     VALUES ($1, (NOW() AT TIME ZONE 'Asia/Aden')::date, '10:00') RETURNING id`, [patientId]);
  return row.id;
}

async function activeVisits(patientId: number): Promise<{ id: number; appointment_id: number | null }[]> {
  const { rows } = await getPool().query<{ id: number; appointment_id: number | null }>(
    `SELECT id, appointment_id FROM visits WHERE patient_id = $1 AND status IN ('waiting', 'called', 'in_chair') ORDER BY id`,
    [patientId]);
  return rows;
}

const walkIn = (p: { id: number; name: string }) =>
  addVisit({ patientName: p.name, patientPhone: null, note: null, patientId: p.id });

describe("(LIVE-4) one active visit per patient per day", () => {
  it("a second walk-in for a patient already in the queue is refused with the existing visit", async () => {
    const p = await patient();
    const first = await walkIn(p);
    const second = walkIn(p);
    await expect(second).rejects.toBeInstanceOf(ActiveVisitExists);
    await expect(walkIn(p)).rejects.toMatchObject({ visitId: first.id });
    expect((await activeVisits(p.id)).map((row) => row.id)).toEqual([first.id]);
  });

  it("marking the appointment arrived for a patient who already walked in attaches it to that visit", async () => {
    const p = await patient();
    const walked = await walkIn(p);
    const appointmentId = await bookToday(p.id);
    expect(await arriveAppointment(appointmentId)).toBe(true);
    expect(await activeVisits(p.id)).toEqual([{ id: walked.id, appointment_id: appointmentId }]);
  });

  it("two devices registering the same patient at once produce one visit", async () => {
    const p = await patient();
    const results = await Promise.allSettled([walkIn(p), walkIn(p), walkIn(p)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")
      .every((result) => (result as PromiseRejectedResult).reason instanceof ActiveVisitExists)).toBe(true);
    expect(await activeVisits(p.id)).toHaveLength(1);
  });

  it("after the visit is finished the patient may come back the same day; walk-ins without a file are never blocked", async () => {
    const p = await patient();
    const first = await walkIn(p);
    await finishVisit(first.id);
    const again = await walkIn(p);
    expect(again.id).not.toBe(first.id);
    const anonymous = { patientName: "بلا ملف", patientPhone: null, note: null };
    await addVisit(anonymous);
    await expect(addVisit(anonymous)).resolves.toBeTruthy();
  });
});
