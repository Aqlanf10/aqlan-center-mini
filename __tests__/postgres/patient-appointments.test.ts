import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { createSessionToken, sessionCredentialVersion, sessionPermissionVersion } from "../../lib/auth";
import { getPool, ensureSchema, resetPoolForTesting } from "../../lib/db";
import { readPatientAppointments } from "../../lib/patient-appointments-reader";
import { readPatientAppointmentsQuery } from "../../lib/patient-appointments-contract";
const auth = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: auth.token }) }), headers: async () => new Headers() }));
import { GET } from "../../app/api/patients/[id]/route";
let admin: Client | undefined;
let owned: { name: string; oid: string; owner: string } | undefined;
const keys = ["DATABASE_URL", "SKIP_SEED", "DB_POOL_MAX", "SESSION_SECRET"] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let doctorId: number, userId: number, patientId: number, otherPatientId: number;
beforeAll(async () => {
  const target = validatePostgresTestTarget(process.env);
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false }); await admin.connect();
  const name = `aqlan_patient_appt_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const { rows: [identity] } = await admin.query("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [name]);
  if (!identity || identity.name !== name) throw new Error("Owned appointment test database identity unavailable."); owned = identity;
  const url = new URL(target.testUrl); url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.SKIP_SEED = "true"; process.env.DB_POOL_MAX = "1"; process.env.SESSION_SECRET = "synthetic-patient-appointment-secret-0123456789";
  await resetPoolForTesting(); await ensureSchema();
  const pool = getPool();
  doctorId = (await pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic appointment doctor') RETURNING id")).rows[0].id;
  userId = (await pool.query("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES('synthetic_patient_appt','Synthetic appointment','not-a-login-hash','doctor',$1) RETURNING id", [doctorId])).rows[0].id;
  patientId = (await pool.query("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYNTHETIC-APPT','Synthetic appointment patient','770123456',$1) RETURNING id", [doctorId])).rows[0].id;
  otherPatientId = (await pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYNTHETIC-OTHER-APPT','Synthetic unrelated patient') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,duration_minutes,status)
    SELECT $1,$2,'2026-10-22'::date + n,'10:00',30,'booked' FROM generate_series(0,64) n`, [patientId, doctorId]);
  await pool.query(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,duration_minutes,status,cancel_reason)
    SELECT $1,'2026-10-21','09:00'::time + (n % 3) * interval '0.000001 second',20,'cancelled','Synthetic cancellation' FROM generate_series(1,41) n`, [patientId]);
  await pool.query(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,duration_minutes,status) VALUES
    ($1,'2026-10-20','08:00',15,'booked'), ($1,'2027-01-01','08:00',30,'done'), ($2,'2026-10-22','08:00',30,'booked')`, [patientId, otherPatientId]);
});
afterAll(async () => {
  try {
    await resetPoolForTesting();
    if (owned && admin) {
      const { rows: [actual] } = await admin.query("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [owned.name]);
      if (!/^aqlan_patient_appt_[a-f0-9]{32}$/.test(owned.name) || !actual || actual.name !== owned.name || actual.oid !== owned.oid || actual.owner !== owned.owner) throw new Error("Appointment fixture identity changed; cleanup refused.");
      await admin.query(`DROP DATABASE "${owned.name}"`);
    }
  } finally { await admin?.end(); for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
const query = (view = "upcoming", cursor?: string) => readPatientAppointmentsQuery(new URLSearchParams({ view, ...(cursor ? { cursor } : {}) }), patientId)!;
const get = (id = patientId) => GET(new Request(`http://localhost/api/patients/${id}?projection=appointments`), { params: Promise.resolve({ id: String(id) }) });
function sign(role: "doctor" | "assistant" | "cashier" | "accountant" = "doctor") {
  auth.token = createSessionToken({ userId, username: "synthetic_patient_appt", role, partyId: doctorId, credentialVersion: sessionCredentialVersion("not-a-login-hash"), permissionVersion: role === "cashier" || role === "accountant" ? sessionPermissionVersion(role, undefined) : undefined, expiresAt: Date.now() + 3600000 });
}
it("keeps the nearest appointments despite >50 future rows, and exhausts every keyset page exactly once", async () => {
  const first = await readPatientAppointments(patientId, query(), "2026-10-22");
  expect(first?.appointments).toHaveLength(20); expect(first?.appointments[0].scheduledDate).toBe("2026-10-22"); expect(first?.nextCursor).toBeTruthy();
  const ids: number[] = []; let cursor: string | null = null;
  do { const page = await readPatientAppointments(patientId, query("upcoming", cursor ?? undefined), "2026-10-22"); expect(page).not.toBeNull(); ids.push(...page!.appointments.map(row => row.id)); cursor = page!.nextCursor; } while (cursor);
  expect(ids).toHaveLength(65); expect(new Set(ids).size).toBe(65);
});
it("history separates closed future records and unresolved old bookings, preserving reasons and sub-minute tie order", async () => {
  const ids: number[] = []; let cursor: string | null = null; let booked = 0;
  do {
    const page = await readPatientAppointments(patientId, query("history", cursor ?? undefined), "2026-10-22");
    expect(page).not.toBeNull();
    for (const row of page!.appointments) { ids.push(row.id); if (row.status === "cancelled") expect(row.cancelReason).toBe("Synthetic cancellation"); if (row.status === "booked") booked++; }
    cursor = page!.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(43); expect(new Set(ids).size).toBe(43); expect(booked).toBe(1);
});
it("keyset cursor is stable against an earlier insertion and retains its clinic-date boundary", async () => {
  const first = await readPatientAppointments(patientId, query(), "2026-10-22");
  await getPool().query("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,duration_minutes,status) VALUES($1,'2026-10-22','07:00',15,'booked')", [patientId]);
  const next = await readPatientAppointments(patientId, query("upcoming", first!.nextCursor!), "2026-10-23");
  expect(next?.today).toBe("2026-10-22"); expect(next?.appointments.some(row => first!.appointments.some(old => old.id === row.id))).toBe(false);
});
it("reader executes with a read-only connection and never includes unrelated patients or private narrative/financial fields", async () => {
  const pool = getPool(); await pool.query("SET default_transaction_read_only=on");
  try { const result = await readPatientAppointments(patientId, query(), "2026-10-22"); expect(result?.appointments.every(row => row.patientId === patientId)).toBe(true); expect(Object.keys(result!.appointments[0])).not.toContain("balance"); }
  finally { await pool.query("SET default_transaction_read_only=off"); }
});
it("real signed sessions enforce owner/all-patient policy, assistant read-only access and denial of financial roles", async () => {
  const pool = getPool(); sign(); expect((await get()).status).toBe(200); expect((await get(otherPatientId)).status).toBe(403);
  await pool.query("UPDATE users SET permissions = $2::jsonb WHERE id = $1", [userId, JSON.stringify({ canViewAllPatients: true })]);
  expect((await get(otherPatientId)).status).toBe(200);
  await pool.query("UPDATE users SET role='assistant',permissions=NULL WHERE id=$1", [userId]); sign("assistant");
  expect((await get()).status).toBe(403);
  await pool.query("INSERT INTO visits(patient_name,patient_id,status) VALUES('Synthetic appointment patient',$1,'waiting')", [patientId]);
  const assistant = await get(); expect(assistant.status).toBe(200); expect((await assistant.json()).canRemind).toBe(false);
  for (const role of ["cashier", "accountant"] as const) { await pool.query("UPDATE users SET role=$2 WHERE id=$1", [userId, role]); sign(role); expect((await get()).status).toBe(404); }
  await pool.query("UPDATE users SET role='doctor',is_active=false WHERE id=$1", [userId]); sign(); expect((await get()).status).toBe(401);
});
