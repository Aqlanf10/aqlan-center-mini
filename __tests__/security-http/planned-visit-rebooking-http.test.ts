import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { addDays, clinicDateString } from "../../lib/schedule";
import { authedGet, authedMutation, harness, type Session } from "./_server";

/** Real built-app/proxy requests; only synthetic records in the harness database.
 * No browser, production connection, status reopening, or financial mutation. */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorA = 0;
let doctorB = 0;
let shiftId = 0;
let today: string;
let serial = 0;
const stamp = randomUUID();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const users = (await db.query<{ username: string; party_id: number }>(
    "SELECT username, party_id FROM users WHERE username IN ('secdoctora', 'secdoctorb')")).rows;
  doctorA = users.find(user => user.username === "secdoctora")!.party_id;
  doctorB = users.find(user => user.username === "secdoctorb")!.party_id;
  const workflow = await authedGet(`/api/patients/${h.seeded.patientAId}/workflow`, h.sessions.admin);
  expect(workflow.status).toBe(200);
  const calendar = await workflow.json() as { timeZone: string; today: string };
  expect(typeof calendar.timeZone).toBe("string");
  today = clinicDateString(new Date(), calendar.timeZone);
  shiftId = (await db.query<{ id: number }>(`INSERT INTO cashier_shifts
    (opened_by, closed_by, status, closed_at) VALUES ('synthetic-rebook', 'synthetic-rebook', 'closed', NOW()) RETURNING id`)).rows[0].id;
}, 120_000);

afterAll(async () => { await db?.end(); });

async function fixture(status: "no_show" | "cancelled" = "no_show", referral = false) {
  const unique = `${stamp}-${++serial}`;
  const patient = (await db.query<{ id: number }>(`INSERT INTO patients
    (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض إعادة حجز اصطناعي', $2) RETURNING id`,
  [`SYN-RB-${unique}`, doctorA])).rows[0].id;
  const doctor = referral ? doctorB : doctorA;
  // The planned session must resolve through real clinical provenance, not the
  // historical appointment doctor or the patient's primary doctor.
  const clinicalCase = (await db.query<{ id: number }>(`INSERT INTO clinical_cases
    (patient_id, specialty, title, responsible_party_id, created_by)
    VALUES ($1, 'general', 'حالة إعادة حجز اصطناعية', $2, 'synthetic-rebook') RETURNING id`,
  [patient, doctor])).rows[0].id;
  const plan = (await db.query<{ id: number }>(`INSERT INTO treatment_plans
    (patient_id, title, total_minor, status) VALUES ($1, 'خطة اصطناعية لإعادة الحجز', 1200, 'active') RETURNING id`, [patient])).rows[0].id;
  const item = (await db.query<{ id: number }>(`INSERT INTO plan_items
    (plan_id, service_name, unit_price_minor, case_id) VALUES ($1, 'بند علاجي اصطناعي', 1200, $2) RETURNING id`, [plan, clinicalCase])).rows[0].id;
  const old = (await db.query<{ id: number }>(`INSERT INTO appointments
    (patient_id, scheduled_date, scheduled_time, status, ended_at, cancel_reason, doctor_id)
    VALUES ($1, $2::date - 1, '10:00', $3, NOW(), 'سبب تاريخي محفوظ', $4) RETURNING id`,
  [patient, today, status, doctor])).rows[0].id;
  const planned = (await db.query<{ id: number }>(`INSERT INTO planned_visits
    (patient_id, plan_id, sequence, title, status, appointment_id, doctor_id, duration_minutes)
    VALUES ($1, $2, 1, 'جلسة اصطناعية', 'scheduled', $3, $4, 30) RETURNING id`, [patient, plan, old, doctor])).rows[0].id;
  await db.query("UPDATE appointments SET planned_visit_id = $2 WHERE id = $1", [old, planned]);
  await db.query("INSERT INTO treatment_sessions (plan_item_id, sequence, planned_visit_id) VALUES ($1, 1, $2)", [item, planned]);
  await db.query(`INSERT INTO appointment_status_log (appointment_id, from_status, to_status, reason, actor)
    VALUES ($1, 'booked', $2, 'سبب تاريخي محفوظ', 'synthetic-rebook')`, [old, status]);
  const invoice = (await db.query<{ id: number }>(`INSERT INTO invoices
    (invoice_number, patient_id, total_minor) VALUES ($1, $2, 1200) RETURNING id`, [`SYN-RB-INV-${unique}`, patient])).rows[0].id;
  await db.query(`INSERT INTO invoice_items (invoice_id, description, unit_price_minor, total_minor)
    VALUES ($1, 'بند مالي محفوظ', 1200, 1200)`, [invoice]);
  await db.query(`INSERT INTO payments
    (receipt_number, patient_id, invoice_id, shift_id, amount_minor, currency, base_amount_minor)
    VALUES ($1, $2, $3, $4, 100, 'YER', 100)`, [`SYN-RB-PAY-${unique}`, patient, invoice, shiftId]);
  let referralId: number | null = null;
  if (referral) {
    referralId = (await db.query<{ id: number }>(`INSERT INTO patient_referrals
      (patient_id, to_name, to_specialty, reason, created_by, kind, doctor_party_id, to_party_id, workflow_state)
      VALUES ($1, 'طبيب الأمن ب', 'endodontics', 'إحالة اصطناعية', 'secdoctora', 'internal', $2, $3, 'accepted') RETURNING id`,
    [patient, doctorA, doctorB])).rows[0].id;
    await db.query("UPDATE appointments SET referral_id = $2 WHERE id = $1", [old, referralId]);
  }
  const workflow = await authedGet(`/api/patients/${patient}/workflow`, h.sessions.admin);
  expect(workflow.status).toBe(200);
  const payload = await workflow.json() as { plannedVisits: { id: number; rebookGeneration: string }[] };
  const projected = payload.plannedVisits.find(visit => visit.id === planned)!;
  expect(projected.rebookGeneration).toMatch(/^[a-f0-9]{32}$/);
  const returnContext = await returnContextFor(patient, planned);
  expect(returnContext).toMatchObject({ patientId: patient, clinicalCaseId: clinicalCase, doctorId: doctor,
    source: { kind: "planned_visit", id: planned } });
  return { patient, plan, item, old, planned, status, referralId, clinicalCase, doctor, body: {
    expectedAppointmentId: old, expectedGeneration: projected.rebookGeneration,
    date: addDays(today, 800 + serial), time: "10:00",
    reason: "طلب المريض موعدًا بديلًا", requestId: randomUUID(),
    returnBookingSource: { kind: "planned_visit" as const, id: planned },
    returnBookingFingerprint: returnContext.fingerprint,
  } };
}
async function returnContextFor(patient: number, planned: number) {
  const response = await authedGet(`/api/patients/${patient}/return-booking-context`
    + `?kind=planned_visit&sourceId=${planned}&originKind=planned_visit&originId=${planned}`, h.sessions.admin);
  expect(response.status).toBe(200);
  const context = await response.json() as { ok: boolean; patientId: number; clinicalCaseId: number;
    doctorId: number; source: { kind: string; id: number }; fingerprint: string };
  expect(context.ok).toBe(true);
  expect(context.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  return context;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, session: Session, body: unknown = f.body) =>
  authedMutation(`/api/planned-visits/${f.planned}/rebook`, session, "POST", JSON.stringify(body));

async function untouchedFingerprint() {
  const tables = ["invoices", "invoice_items", "payments", "cashier_shifts", "journal_manual", "journal_manual_lines",
    "patient_opening_balances", "expenses", "payables", "treatment_plans", "plan_items", "treatment_sessions",
    "visits", "visit_procedures", "plan_installments", "clinical_cases"] as const;
  const result: Record<string, string> = {};
  for (const table of tables) {
    result[table] = (await db.query<{ value: string }>(`SELECT md5(COALESCE(
      string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) AS value FROM ${table} t`)).rows[0].value;
  }
  return result;
}
async function history(f: Fixture) {
  return {
    appointment: (await db.query("SELECT to_jsonb(a) - 'planned_visit_id' AS row FROM appointments a WHERE id = $1", [f.old])).rows,
    statusLog: (await db.query("SELECT * FROM appointment_status_log WHERE appointment_id = $1 ORDER BY id", [f.old])).rows,
  };
}
async function noReplacement(f: Fixture) {
  expect((await db.query("SELECT id FROM appointments WHERE patient_id = $1 ORDER BY id", [f.patient])).rows).toEqual([{ id: f.old }]);
  expect((await db.query("SELECT appointment_id FROM planned_visits WHERE id = $1", [f.planned])).rows[0].appointment_id).toBe(f.old);
}
async function projection(f: Fixture, session: Session, canRebook: boolean) {
  for (const endpoint of ["workflow", "plans"]) {
    const response = await authedGet(`/api/patients/${f.patient}/${endpoint}`, session);
    expect(response.status).toBe(200);
    const payload = await response.json() as { plannedVisits: { id: number; appointmentStatus: string; canRebook: boolean; rebookGeneration: string }[] };
    const visit = payload.plannedVisits.find(visit => visit.id === f.planned)!;
    expect(visit).toMatchObject({ canRebook });
    expect(visit.rebookGeneration).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(payload)).not.toContain("rebookHasReferral");
    expect(JSON.stringify(payload)).not.toContain("rebookReferralReceiverId");
  }
}
async function denied(response: Response, expectedStatus: number) {
  expect(response.status).toBe(expectedStatus);
  const body = await response.json() as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["message"]);
  expect(String(body.message)).toMatch(/[\u0600-\u06ff]/);
}

describe("explicit planned-session rebooking through the built app and proxy", () => {
  it.each([
    { who: "admin", status: "cancelled" },
    { who: "reception", status: "no_show" },
    { who: "doctorA", status: "cancelled" },
  ] as const)("$who rebooks $status without touching history, clinical execution, or money", async ({ who, status }) => {
    const f = await fixture(status);
    await projection(f, h.sessions[who], true);
    const before = await history(f);
    const untouched = await untouchedFingerprint();
    const response = await post(f, h.sessions[who]);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = await response.json() as { appointmentId: number; title: string; replayed: boolean };
    expect(result).toMatchObject({ title: "جلسة اصطناعية", replayed: false });
    expect(Number.isSafeInteger(result.appointmentId)).toBe(true);
    expect(await history(f)).toEqual(before);
    expect(await untouchedFingerprint()).toEqual(untouched);
    expect((await db.query("SELECT id, planned_visit_id, status, doctor_id FROM appointments WHERE patient_id = $1 ORDER BY id", [f.patient])).rows).toEqual([
      { id: f.old, planned_visit_id: null, status, doctor_id: f.doctor },
      { id: result.appointmentId, planned_visit_id: f.planned, status: "booked", doctor_id: f.doctor },
    ]);
    expect((await db.query("SELECT appointment_id, status FROM planned_visits WHERE id = $1", [f.planned])).rows[0])
      .toEqual({ appointment_id: result.appointmentId, status: "scheduled" });
    await projection(f, h.sessions[who], false);
  });

  it.each(["missing", "stale"] as const)("rejects a %s return fingerprint without replacing history or clinical work", async kind => {
    const f = await fixture();
    const body: Record<string, unknown> = { ...f.body };
    if (kind === "missing") delete body.returnBookingFingerprint;
    else {
      // A real current-responsibility change invalidates the displayed proposal.
      await db.query("UPDATE clinical_cases SET responsible_party_id = $2 WHERE id = $1", [f.clinicalCase, doctorB]);
      const current = await returnContextFor(f.patient, f.planned);
      expect(current.doctorId).toBe(doctorB);
      expect(current.fingerprint).not.toBe(f.body.returnBookingFingerprint);
    }
    const before = await history(f);
    const untouched = await untouchedFingerprint();
    const response = await post(f, h.sessions.reception, body);
    expect(response.status).toBe(409);
    const result = await response.json() as { message: string; code: string };
    expect(result.code).toBe(kind === "missing" ? "return_booking_context_required" : "return_booking_source_changed");
    expect(result.message).toMatch(/[\u0600-\u06ff]/);
    await noReplacement(f);
    expect(await history(f)).toEqual(before);
    expect(await untouchedFingerprint()).toEqual(untouched);
    expect((await db.query("SELECT id FROM audit_log WHERE action = 'planned_visit.rebook' AND entity_id = $1", [String(f.planned)])).rows).toHaveLength(0);
  });

  it.each(["cashier", "accountant", "doctorB", "portalA"] as const)("denies %s before any replacement or side effect", async who => {
    const f = await fixture();
    const before = await history(f);
    const untouched = await untouchedFingerprint();
    await denied(await post(f, h.sessions[who]), who === "portalA" ? 401 : 403);
    await noReplacement(f);
    expect(await history(f)).toEqual(before);
    expect(await untouchedFingerprint()).toEqual(untouched);
  });

  it("returns 201 then same-ID 200 after a lost reply, but changed intent is 409", async () => {
    const f = await fixture();
    const untouched = await untouchedFingerprint();
    const first = await post(f, h.sessions.reception);
    expect(first.status).toBe(201);
    const saved = await first.json() as { appointmentId: number; title: string; replayed: boolean };
    const repeated = await post(f, h.sessions.reception);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ ...saved, replayed: true });
    await denied(await post(f, h.sessions.reception, { ...f.body, time: "11:00" }), 409);
    expect((await db.query("SELECT id FROM appointments WHERE patient_id = $1", [f.patient])).rows).toHaveLength(2);
    const audits = (await db.query("SELECT details FROM audit_log WHERE action = 'planned_visit.rebook' AND entity_id = $1", [String(f.planned)])).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({ requestId: f.body.requestId, oldAppointmentId: f.old, newAppointmentId: saved.appointmentId });
    expect(await untouchedFingerprint()).toEqual(untouched);
  });

  it("projects referral authority without internal identifiers and only its receiver may rebook", async () => {
    const f = await fixture("no_show", true);
    await projection(f, h.sessions.doctorA, false);
    await projection(f, h.sessions.doctorB, true);
    await projection(f, h.sessions.reception, true);
    await denied(await post(f, h.sessions.doctorA), 403);
    await noReplacement(f);
    const before = await history(f);
    const untouched = await untouchedFingerprint();
    const response = await post(f, h.sessions.doctorB);
    expect(response.status).toBe(201);
    const result = await response.json() as { appointmentId: number };
    expect((await db.query("SELECT referral_id FROM appointments WHERE id = $1", [result.appointmentId])).rows[0].referral_id).toBe(f.referralId);
    expect((await db.query("SELECT workflow_state FROM patient_referrals WHERE id = $1", [f.referralId])).rows[0].workflow_state).toBe("scheduled");
    expect(await history(f)).toEqual(before);
    expect(await untouchedFingerprint()).toEqual(untouched);
    await projection(f, h.sessions.doctorB, false);
  });

  it.each(["no_show", "cancelled"] as const)("does not let ordinary Start reopen %s history", async status => {
    const f = await fixture(status);
    const before = await history(f);
    const untouched = await untouchedFingerprint();
    await denied(await authedMutation("/api/visits", h.sessions.reception, "POST", JSON.stringify({ plannedVisitId: f.planned })), 409);
    await noReplacement(f);
    expect(await history(f)).toEqual(before);
    expect(await untouchedFingerprint()).toEqual(untouched);
  });
});
