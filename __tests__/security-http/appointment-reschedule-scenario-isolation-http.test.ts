import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

// Browser-free witness for independent navigation-test fixtures. The existing
// patient-overlap suite covers POST confirmation; this covers PATCH destinations.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 240_000);
afterAll(async () => { await db?.end(); });

it("a retained same-patient destination requires nearby confirmation; an independent patient does not", async () => {
  const patient = async () => {
    const result = await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
      SELECT $1, 'Synthetic reschedule isolation patient', primary_doctor_id FROM patients WHERE id=$2 RETURNING id`,
    [`RESCHEDULE-${randomUUID()}`, h.seeded.patientAId]);
    expect(result.rowCount).toBe(1);
    return result.rows[0].id;
  };
  const samePatient = await patient(), separatePatient = await patient();
  // A distant Monday isolates day capacity from the other reviewed HTTP suites.
  const { rows: [dates] } = await db.query<{ original: string; destination: string }>(`SELECT
    (date_trunc('week', NOW() AT TIME ZONE 'Asia/Aden')::date + 63)::text AS original,
    (date_trunc('week', NOW() AT TIME ZONE 'Asia/Aden')::date + 70)::text AS destination`);
  const seed = async (patientId: number, date: string, time: string) => {
    const { rows: [row] } = await db.query<{ id: number }>(`INSERT INTO appointments
      (patient_id, scheduled_date, scheduled_time, duration_minutes, status, note)
      VALUES ($1,$2::date,$3,15,'booked','Synthetic reschedule isolation') RETURNING id`, [patientId, date, time]);
    return row.id;
  };
  const retainedId = await seed(samePatient, dates.destination, "14:00");
  const blockedId = await seed(samePatient, dates.original, "09:00");
  const independentId = await seed(separatePatient, dates.original, "10:00");
  const snapshot = async (id: number) => (await db.query(`SELECT id, patient_id, status,
    scheduled_date::text AS date, to_char(scheduled_time,'HH24:MI') AS time, duration_minutes
    FROM appointments WHERE id=$1`, [id])).rows[0];
  const retainedBefore = await snapshot(retainedId), blockedBefore = await snapshot(blockedId);
  const move = (id: number) => authedMutation(`/api/appointments/${id}`, h.sessions.reception, "PATCH",
    JSON.stringify({ action: "reschedule", date: dates.destination, time: "15:00", reason: "Synthetic isolated navigation" }));
  const blocked = await move(blockedId);
  expect(blocked.status).toBe(409);
  const refusal = await blocked.json();
  expect(refusal).toMatchObject({ conflict: { kind: "nearby_patient_appointments", canOverride: false } });
  expect(refusal.conflict.nearbyAppointments).toEqual([
    { id: retainedId, scheduledDate: dates.destination, scheduledTime: "14:00", doctorName: null },
  ]);
  expect(refusal.conflict.confirmationToken).toBeTypeOf("string");
  expect(refusal.conflict.confirmationToken.length).toBeGreaterThan(0);
  expect(await snapshot(blockedId)).toEqual(blockedBefore);
  expect(await snapshot(retainedId)).toEqual(retainedBefore);

  // No acknowledgement/override is submitted. A genuinely different patient
  // may use the non-overlapping target time without silencing either guard.
  const independent = await move(independentId);
  expect(independent.status).toBe(200);
  expect(await independent.json()).toMatchObject({ ok: true, appointment: { id: independentId, patientId: separatePatient } });
  expect(await snapshot(independentId)).toMatchObject({ status: "booked", date: dates.destination, time: "15:00" });
  expect(await snapshot(blockedId)).toEqual(blockedBefore);
  expect(await snapshot(retainedId)).toEqual(retainedBefore);
});
