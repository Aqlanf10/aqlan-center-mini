import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { createSessionToken, sessionCredentialVersion } from "../../lib/auth";
import { getPool, ensureSchema, resetPoolForTesting } from "../../lib/db";
import { readDoctorDailySchedule } from "../../lib/doctor-daily-schedule";
const auth = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: auth.token }) }), headers: async () => new Headers() }));
import { GET } from "../../app/api/appointments/mine/route";
let admin: Client | undefined;
let owned: { name: string; oid: string; owner: string } | undefined;
const keys = ['DATABASE_URL', 'SKIP_SEED', 'DB_POOL_MAX', 'SESSION_SECRET'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let doctorId: number, otherDoctorId: number, userId: number, patientId: number;
beforeAll(async () => {
  const target = validatePostgresTestTarget(process.env);
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  const name = `aqlan_daily_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const { rows: [identity] } = await admin.query('SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [name]);
  if (!identity || identity.name !== name) throw new Error('Owned daily schedule database identity unavailable.');
  owned = identity;
  const url = new URL(target.testUrl); url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.SKIP_SEED = 'true'; process.env.DB_POOL_MAX = '1';
  process.env.SESSION_SECRET = 'synthetic-daily-test-secret-0123456789';
  await resetPoolForTesting();
  // Setup is separate from the adapter: the production reader never calls ensureSchema.
  await ensureSchema();
  const pool = getPool();
  doctorId = (await pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic schedule doctor') RETURNING id")).rows[0].id;
  otherDoctorId = (await pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic other doctor') RETURNING id")).rows[0].id;
  userId = (await pool.query("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES('synthetic_daily','Synthetic schedule','not-a-login-hash','doctor',$1) RETURNING id", [doctorId])).rows[0].id;
  patientId = (await pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYNTHETIC-DAILY','Synthetic patient',$1) RETURNING id", [doctorId])).rows[0].id;
  await pool.query(`INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,duration_minutes,status) VALUES
    ($1,$2,'2026-10-22','09:00',20,'booked'), ($1,$2,'2026-10-22','10:00',30,'cancelled'),
    ($1,$3,'2026-10-22','11:00',30,'booked'), ($1,NULL,'2026-10-22','12:00',30,'booked'),
    ($1,$2,'2026-10-23','09:00',20,'booked')`, [patientId,doctorId,otherDoctorId]);

});
afterAll(async () => {
  try {
    await resetPoolForTesting();
    if (owned && admin) {
      const { rows: [actual] } = await admin.query('SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [owned.name]);
      if (!/^aqlan_daily_[a-f0-9]{32}$/.test(owned.name) || !actual || actual.name !== owned.name || actual.oid !== owned.oid || actual.owner !== owned.owner)
        throw new Error('Daily schedule fixture identity changed; cleanup refused.');
      await admin.query(`DROP DATABASE "${owned.name}"`);
    }
  } finally {
    await admin?.end();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

function sign(partyId = doctorId) {
  auth.token = createSessionToken({ userId, username: "synthetic_daily", role: "doctor", partyId,
    credentialVersion: sessionCredentialVersion("not-a-login-hash"), expiresAt: Date.now() + 3600000 });
}
const request = (extra = "") => new Request(`http://localhost/api/appointments/mine?date=2026-10-22${extra}`);
it("executes exact assignment/date filtering including cancelled without owned/unassigned leakage", async () => {
  const rows = await readDoctorDailySchedule(doctorId, "2026-10-22");
  expect(rows?.map(row => [row.time, row.durationMinutes, row.status])).toEqual([["09:00",20,"booked"],["10:00",30,"cancelled"]]);
  expect(await readDoctorDailySchedule(doctorId, "2026-10-24")).toEqual([]);
});
it("authenticates a real signed session, refreshes stale party claim and forbids doctor override", async () => {
  sign(otherDoctorId);
  const response = await GET(request());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.appointments.map((row: { time: string }) => row.time)).toEqual(["09:00","10:00"]);
  expect(body.appointments[0].patientHref).toBe(`/patients/${patientId}`);
  expect((await GET(request(`&doctorId=${otherDoctorId}`))).status).toBe(400);
});
it("rejects inactive user, unlinked user, and inactive/non-doctor parties", async () => {
  sign(); const pool = getPool();
  await pool.query("UPDATE users SET is_active=false WHERE id=$1", [userId]);
  expect((await GET(request())).status).toBe(401);
  await pool.query("UPDATE users SET is_active=true,party_id=NULL WHERE id=$1", [userId]);
  expect((await GET(request())).status).toBe(403);
  await pool.query("UPDATE users SET party_id=$2 WHERE id=$1", [userId,doctorId]);
  await pool.query("UPDATE parties SET is_active=false WHERE id=$1", [doctorId]);
  expect((await GET(request())).status).toBe(403);
  await pool.query("UPDATE parties SET is_active=true,kind='supplier' WHERE id=$1", [doctorId]);
  expect((await GET(request())).status).toBe(403);
  await pool.query("UPDATE parties SET kind='doctor' WHERE id=$1", [doctorId]);
});

it("reader runs under a read-only connection and only badges a same-patient referral", async () => {
  const pool = getPool();
  const otherPatient = (await pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYNTHETIC-OTHER','Synthetic unrelated') RETURNING id")).rows[0].id;
  const referral = async (id: number) => (await pool.query(`INSERT INTO patient_referrals(patient_id,to_name,to_specialty,reason,created_by,kind,to_party_id,workflow_state)
    VALUES($1,'Synthetic receiver','general','PRIVATE narrative not for schedule','test','internal',$2,'requested') RETURNING id`, [id,doctorId])).rows[0].id;
  const matched = await referral(patientId), mismatched = await referral(otherPatient);
  await pool.query("UPDATE appointments SET referral_id=$1 WHERE scheduled_time='09:00' AND doctor_id=$2", [matched,doctorId]);
  await pool.query("UPDATE appointments SET referral_id=$1 WHERE scheduled_time='10:00' AND doctor_id=$2", [mismatched,doctorId]);
  await pool.query('SET default_transaction_read_only=on');
  try {
    const result = await readDoctorDailySchedule(doctorId, '2026-10-22');
    expect(result?.map(row => row.hasReferral)).toEqual([true,false]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE narrative');
  } finally { await pool.query('SET default_transaction_read_only=off'); }
});
