import { Client } from "pg";
import { expect, it } from "vitest";
import { authedGet, authedMutation, harness } from "./_server";

it("assigns an existing orthodontic case and books its signed visit with the current doctor", async () => {
  const h = await harness();
  const db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  await db.connect();
  try {
    const { rows: [doctors] } = await db.query<{ performer: number; responsible: number }>(
      `SELECT max(party_id) FILTER (WHERE username = 'secdoctora') AS performer,
              max(party_id) FILTER (WHERE username = 'secdoctorb') AS responsible FROM users`,
    );
    const { rows: [{ id: patientId, date }] } = await db.query<{ id: number; date: string }>(
      `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
       VALUES ('SEC-ORTHO-CHECKOUT', 'Synthetic signed checkout', $1)
       RETURNING id, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date + 98
         + CASE WHEN EXTRACT(ISODOW FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden') = 5 THEN 1 ELSE 0 END)::text AS date`,
      [doctors.performer],
    );
    const { rows: [{ id: caseId }] } = await db.query<{ id: number }>(
      "INSERT INTO ortho_cases (patient_id, created_by) VALUES ($1, 'secadmin') RETURNING id", [patientId],
    );
    const { rows: [{ id: visitId }] } = await db.query<{ id: number }>(
      `INSERT INTO visits (patient_id, patient_name, doctor_id, status, signed_at)
       VALUES ($1, 'Synthetic signed checkout', $2, 'done', now()) RETURNING id`, [patientId, doctors.performer],
    );
    await db.query("INSERT INTO ortho_adjustments (case_id, visit_id, recorded_by) VALUES ($1, $2, 'secdoctora')", [caseId, visitId]);
    const post = (time: string) => authedMutation(`/api/visits/${visitId}/next`, h.sessions.admin, "POST",
      JSON.stringify({ date, time, durationMinutes: 15 }));
    const assign = (who: typeof h.sessions.admin, doctorId: number, expected: number | null) =>
      authedMutation(`/api/ortho/${caseId}`, who, "PATCH", JSON.stringify({
        responsibleDoctorId: doctorId, expectedResponsibleDoctorId: expected,
      }));

    expect((await post("10:00")).status).toBe(409);
    expect((await assign(h.sessions.reception, doctors.responsible, null)).status).toBe(403);
    const assignment = await assign(h.sessions.admin, doctors.responsible, null);
    expect(assignment.status, await assignment.clone().text()).toBe(200);
    expect((await assign(h.sessions.admin, doctors.performer, null)).status).toBe(409);

    const booked = await post("10:00");
    expect(booked.status, await booked.clone().text()).toBe(201);
    const { appointmentId } = await booked.json() as { appointmentId: number };
    expect((await post("10:00")).status).toBe(409);
    expect((await db.query("SELECT id, doctor_id FROM appointments WHERE patient_id = $1", [patientId])).rows)
      .toEqual([{ id: appointmentId, doctor_id: doctors.responsible }]);
    const patient = await authedGet(`/api/patients/${patientId}?projection=appointments&view=upcoming`, h.sessions.admin);
    expect(patient.status).toBe(200);
    expect((await patient.json()).appointments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: appointmentId, doctorId: doctors.responsible, doctorName: expect.any(String) }),
    ]));
    const schedule = await authedGet(`/api/appointments/mine?date=${date}`, h.sessions.doctorB);
    expect(schedule.status).toBe(200);
    expect((await schedule.json()).appointments).toContainEqual(expect.objectContaining({ appointmentId, patientId }));
    expect((await db.query("SELECT doctor_id FROM visits WHERE id = $1", [visitId])).rows)
      .toEqual([{ doctor_id: doctors.performer }]);
    expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'ortho.responsible_doctor' AND entity_id = $1", [String(caseId)])).rows)
      .toEqual([{ n: 1 }]);
  } finally {
    await db.end();
  }
}, 35_000);
