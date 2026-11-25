import { Client } from "pg";
import { expect, it } from "vitest";
import { authedGet, authedMutation, harness } from "./_server";

it("books a saved tightening for the current clinician and refuses a busy or superseded assignment", async () => {
  const h = await harness();
  const db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  await db.connect();
  try {
    const { rows: [doctors] } = await db.query<{ responsible: number; replacement: number }>(
      `SELECT max(party_id) FILTER (WHERE username = 'secdoctora') AS responsible,
              max(party_id) FILTER (WHERE username = 'secdoctorb') AS replacement FROM users`,
    );
    const { rows: [{ id: patientId, date }] } = await db.query<{ id: number; date: string }>(
      `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
       VALUES ('SEC-ORTHO-RETURN', 'Synthetic tightening return HTTP', $1)
       RETURNING id, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden')::date + 91
         + CASE WHEN EXTRACT(ISODOW FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Aden') = 5 THEN 1 ELSE 0 END)::text AS date`,
      [doctors.responsible],
    );
    const { rows: [{ id: caseId }] } = await db.query<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, responsible_doctor_id, created_by) VALUES ($1, $2, 'secadmin') RETURNING id`,
      [patientId, doctors.responsible],
    );
    const { rows: [{ id: adjustmentId }] } = await db.query<{ id: number }>(
      `INSERT INTO ortho_adjustments (case_id, recorded_by) VALUES ($1, 'secdoctorb') RETURNING id`, [caseId],
    );
    const path = `/api/ortho/${caseId}/return-booking?patientId=${patientId}&adjustmentId=${adjustmentId}`;
    const preview = async (doctorId: number) => {
      const res = await authedGet(path, h.sessions.reception);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, patientId, caseId, adjustmentId, doctorId });
      expect(body.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      return body.fingerprint as string;
    };
    const book = (fingerprint: string, time: string) => authedMutation(
      "/api/appointments", h.sessions.reception, "POST", JSON.stringify({
        patientId, date, time, durationMinutes: 15, appointmentType: "follow_up",
        orthoReturn: { caseId, adjustmentId, fingerprint },
      }),
    );
    const schedule = async (session: typeof h.sessions.doctorA) => {
      const res = await authedGet(`/api/appointments/mine?date=${date}`, session);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json() as { appointments: { appointmentId: number; patientId: number }[] })
        .appointments.filter(row => row.patientId === patientId);
    };

    expect((await db.query(`SELECT o.status, o.responsible_doctor_id, p.kind, p.is_active, a.id AS adjustment_id
      FROM ortho_cases o JOIN parties p ON p.id = o.responsible_doctor_id
      JOIN ortho_adjustments a ON a.case_id = o.id WHERE o.id = $1`, [caseId])).rows).toEqual([
        expect.objectContaining({ status: "active", responsible_doctor_id: doctors.responsible, kind: "doctor", is_active: true, adjustment_id: adjustmentId }),
      ]);
    const original = await preview(doctors.responsible);
    const first = await book(original, "10:00");
    expect(first.status).toBe(201);
    const appointment = await first.json();
    expect(appointment).toMatchObject({ patientId, doctorId: doctors.responsible, scheduledDate: date });
    expect(await schedule(h.sessions.doctorA)).toEqual([expect.objectContaining({ appointmentId: appointment.id })]);
    expect(await schedule(h.sessions.doctorB)).toEqual([]);

    await db.query("BEGIN");
    try {
      await db.query("SELECT id FROM ortho_cases WHERE id = $1 FOR UPDATE", [caseId]);
      const busy = await book(original, "10:45");
      expect(busy.status).toBe(400);
      expect(await busy.json()).toMatchObject({ code: "ortho_return_review_required" });
    } finally {
      await db.query("ROLLBACK");
    }
    await db.query("UPDATE ortho_cases SET responsible_doctor_id = $2 WHERE id = $1", [caseId, doctors.replacement]);
    const stale = await book(original, "11:30");
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ code: "ortho_return_review_required" });
    const second = await book(await preview(doctors.replacement), "11:30");
    expect(second.status).toBe(201);
    const reassigned = await second.json();
    expect(reassigned).toMatchObject({ patientId, doctorId: doctors.replacement });
    expect(await schedule(h.sessions.doctorB)).toEqual([expect.objectContaining({ appointmentId: reassigned.id })]);
    expect(await schedule(h.sessions.doctorA)).toEqual([expect.objectContaining({ appointmentId: appointment.id })]);
  } finally {
    await db.end();
  }
}, 35_000);
