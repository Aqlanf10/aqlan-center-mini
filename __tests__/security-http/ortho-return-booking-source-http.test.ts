import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AppointmentService } from "../../lib/appointment-services";
import { addDays } from "../../lib/schedule";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

// Real built HTTP boundary, no browser or synthetic source fingerprints. Only
// fresh fixture rows in the isolated harness DB; no financial mutations.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(target.hostname);
  expect(target.pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 120_000);
afterAll(async () => { await db?.end(); });

async function unchangedState(patientId: number) {
  return (await db.query(`SELECT
    (SELECT to_jsonb(p) FROM patients p WHERE p.id=$1) AS patient,
    (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM ortho_cases c WHERE c.patient_id=$1) AS cases,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id WHERE c.patient_id=$1) AS adjustments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]'::jsonb) FROM visits v WHERE v.patient_id=$1) AS visits,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM treatment_plans p WHERE p.patient_id=$1) AS plans,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM invoices i WHERE i.patient_id=$1) AS invoices,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM payments p WHERE p.patient_id=$1) AS payments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.currency),'[]'::jsonb) FROM patient_opening_balances o WHERE o.patient_id=$1) AS opening
  `, [patientId])).rows[0];
}

it("rejects stale ortho responsibility with 400 and books once using a fresh server-issued source", async () => {
  const doctors = (await db.query<{ username: string; party_id: number }>(
    "SELECT username,party_id FROM users WHERE username IN ('secdoctora','secdoctorb')")).rows;
  const currentDoctor = doctors.find(row => row.username === "secdoctorb")!.party_id;
  const nextDoctor = doctors.find(row => row.username === "secdoctora")!.party_id;
  expect(currentDoctor).not.toBe(nextDoctor);
  const patientId = (await db.query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,'مريض مصدر عودة اصطناعي',$2) RETURNING id",
    [`SYN-ORTHO-RETURN-${randomUUID()}`, nextDoctor])).rows[0].id;
  const caseId = (await db.query<{ id: number }>(`INSERT INTO ortho_cases
    (patient_id,appliance,arches,slot,created_by,responsible_doctor_id)
    VALUES($1,'fixed_metal','both','022','synthetic-return-http',$2) RETURNING id`, [patientId, currentDoctor])).rows[0].id;
  const workflow = await authedGet(`/api/patients/${patientId}/workflow`, h.sessions.admin);
  expect(workflow.status).toBe(200);
  const { today } = await workflow.json() as { today: string };
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // Same seeded clinic schedule and canonical service as the built board test;
  // a distinct distant date avoids its provider/chair collision fixtures.
  const date = addDays(today, 1207);
  const catalog = await authedGet("/api/settings/appointment-services", h.sessions.reception);
  expect(catalog.status).toBe(200);
  const service = ((await catalog.json()) as { services: AppointmentService[] }).services.find(row => row.code === "ORTHO_FOLLOW_UP")!;
  expect(service).toMatchObject({ isActive: true, specialty: "orthodontics", legacyType: "follow_up" });
  const contextPath = `/api/patients/${patientId}/return-booking-context?kind=ortho_case&sourceId=${caseId}`;
  const readContext = async (doctorId: number) => {
    const response = await authedGet(contextPath, h.sessions.reception);
    expect(response.status).toBe(200);
    const proof = await response.json() as { source: { kind: string; id: number }; fingerprint: string };
    expect(proof).toMatchObject({ ok: true, patientId, orthoCaseId: caseId, source: { kind: "ortho_case", id: caseId }, doctorId });
    expect(proof.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    return proof;
  };
  const original = await readContext(currentDoctor);
  const payload = { patientId, date, time: "16:00", durationMinutes: service.defaultDurationMinutes,
    serviceId: service.id, appointmentType: "follow_up", bookingIntent: "ortho_follow_up", isNewPatient: false,
    returnBookingSource: original.source, returnBookingFingerprint: original.fingerprint };
  const raw = JSON.stringify(payload);
  const before = await unchangedState(patientId);
  const settingsPath = `/api/patients/${patientId}/responsibility?kind=ortho&sourceId=${caseId}`;
  const settingsRead = await authedGet(settingsPath, h.sessions.admin);
  expect(settingsRead.status).toBe(200);
  const settings = await settingsRead.json();
  expect(settings.doctorId).toBe(currentDoctor);
  const changed = await authedMutation(`/api/patients/${patientId}/responsibility`, h.sessions.admin, "PATCH", JSON.stringify({
    kind: "ortho", sourceId: caseId, expectedSourceFingerprint: settings.sourceFingerprint,
    doctorId: nextDoctor, reason: "تغيير مسؤولية اصطناعي للتحقق من رفض مصدر عودة قديم",
  }));
  expect(changed.status).toBe(200);
  expect((await changed.json()).doctorId).toBe(nextDoctor);
  const afterAuthorizedChange = await unchangedState(patientId);
  expect({ ...afterAuthorizedChange, cases: before.cases }).toEqual(before);
  expect(afterAuthorizedChange.cases).toEqual([expect.objectContaining({ id: caseId, responsible_doctor_id: nextDoctor })]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stale = await authedMutation("/api/appointments", h.sessions.reception, "POST", raw);
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ code: "return_booking_source_changed" });
    expect((await db.query("SELECT id FROM appointments WHERE patient_id=$1", [patientId])).rows).toEqual([]);
    expect(await unchangedState(patientId)).toEqual(afterAuthorizedChange);
  }
  const fresh = await readContext(nextDoctor);
  expect(fresh.fingerprint).not.toBe(original.fingerprint);
  expect(fresh.source).toEqual(original.source);
  expect(JSON.stringify(payload)).toBe(raw);
  const booked = await authedMutation("/api/appointments", h.sessions.reception, "POST", JSON.stringify({
    ...payload, returnBookingSource: fresh.source, returnBookingFingerprint: fresh.fingerprint,
  }));
  expect(booked.status).toBe(201);
  const appointment = await booked.json();
  expect(appointment).toMatchObject({ patientId, doctorId: nextDoctor, scheduledDate: date });
  expect((await db.query("SELECT id,doctor_id,service_id FROM appointments WHERE patient_id=$1", [patientId])).rows)
    .toEqual([{ id: appointment.id, doctor_id: nextDoctor, service_id: service.id }]);
  expect(await unchangedState(patientId)).toEqual(afterAuthorizedChange);
}, 90_000);
