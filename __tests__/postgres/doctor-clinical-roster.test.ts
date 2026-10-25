import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { reviewHrPersonIdentity, applyHrPersonIdentityPlan } from '../../lib/hr-person-identity';
import { Client } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { validatePostgresTestTarget } from './_safe-target';
import { readDoctorClinicalRoster } from '../../lib/doctor-clinical-roster';
import { getPool, ensureSchema, resetPoolForTesting } from '../../lib/db';

// Own exactly one synthetic database. Never reset/drop the supplied database.
let admin: Client | undefined;
let owned: { name: string; oid: string; owner: string } | undefined;
const keys = ['DATABASE_URL', 'SKIP_SEED', 'DB_POOL_MAX', 'SESSION_SECRET'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let doctorId: number, staffId: number;
beforeAll(async () => {
  const target = validatePostgresTestTarget(process.env);
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  const name = `aqlan_roster_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const { rows: [identity] } = await admin.query('SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [name]);
  if (!identity || identity.name !== name) throw new Error('Owned roster database identity unavailable.');
  owned = identity;
  const url = new URL(target.testUrl); url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.SKIP_SEED = 'true'; process.env.DB_POOL_MAX = '2';
  process.env.SESSION_SECRET = 'synthetic-roster-test-secret-0123456789';
  await resetPoolForTesting();
  // Setup is separate from the adapter: the production reader never calls ensureSchema.
  await ensureSchema();
  const pool = getPool();
  doctorId = (await pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic roster doctor') RETURNING id")).rows[0].id;
  const userId = (await pool.query("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES('synthetic_roster','Synthetic roster','not-a-login-hash','doctor',$1) RETURNING id", [doctorId])).rows[0].id;
  staffId = (await pool.query("INSERT INTO hr_staff(full_name,user_id,department,created_by) VALUES('Synthetic roster',$1,'doctors','test') RETURNING id", [userId])).rows[0].id;
  await pool.query(`INSERT INTO hr_work_schedules(staff_id,name,effective_from,working_days,shift_start_time,shift_end_time,crosses_midnight,schedule_type,created_by)
    VALUES($1,'Synthetic night','2026-01-01','[0,1,2,3,4,5,6]','22:00','04:00',true,'night','test')`, [staffId]);
});
afterAll(async () => {
  try {
    await resetPoolForTesting();
    if (owned && admin) {
      const { rows: [actual] } = await admin.query('SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [owned.name]);
      if (!/^aqlan_roster_[a-f0-9]{32}$/.test(owned.name) || !actual || actual.name !== owned.name || actual.oid !== owned.oid || actual.owner !== owned.owner)
        throw new Error('Roster fixture identity changed; cleanup refused.');
      await admin.query(`DROP DATABASE "${owned.name}"`);
    }
  } finally {
    await admin?.end();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});
it('reads real schema dates, JSON weekdays and an overnight assignment without any read-side writes', async () => {
  const pool = getPool();
  // The adapter additionally starts its own explicitly READ ONLY transaction.
  await pool.query('SET default_transaction_read_only=on');
  try {
    const result = await readDoctorClinicalRoster(doctorId, '2026-10-21', 'Asia/Aden');
    expect(result).toMatchObject({ status: 'resolved', staffId, doctorPartyId: doctorId, effectiveFrom: '2026-01-01',
      intervals: [{ startTime: '22:00', endTime: '04:00', startDayOffset: 0, endDayOffset: 1 }] });
  } finally { await pool.query('SET default_transaction_read_only=off'); }
});
it('subtracts full-day approved leave from the next-day tail on the actual schema', async () => {
  const pool = getPool();
  await pool.query("INSERT INTO hr_leave_types(code,name_ar,is_paid) VALUES('annual','Synthetic roster leave',true) ON CONFLICT(code) DO NOTHING");
  await pool.query(`INSERT INTO hr_leave_requests(staff_id,leave_type_code,start_date,end_date,days_count,reason,status,created_by)
    VALUES($1,'annual','2026-10-22','2026-10-22',1,'Synthetic test','approved','test')`, [staffId]);
  const result = await readDoctorClinicalRoster(doctorId, '2026-10-21', 'Asia/Aden');
  expect(result.intervals).toEqual([{ startTime: '22:00', endTime: '00:00', startDayOffset: 0, endDayOffset: 1 }]);
  expect(result.approvedClosureIntervals).toHaveLength(1);
});

it('reads explicit staff-party identity on the canonical candidate schema without requiring a login account', async () => {
  const pool = getPool();
  // Candidate schema is installed only inside this owned disposable test database.
  // This is not schema activation in the reader, application startup or Production.
  await pool.query(readFileSync(new URL('../../docs/proposals/hr-person-identity.sql', import.meta.url), 'utf8'));
  const reviewerId = (await pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('roster_reviewer','Synthetic reviewer','synthetic-review-hash','admin') RETURNING id")).rows[0].id;
  const reviewer: SessionPayload = { userId: reviewerId, username: 'roster_reviewer', role: 'admin',
    credentialVersion: sessionCredentialVersion('synthetic-review-hash'), expiresAt: Date.now() + 3600000 };
  const partyId = (await pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic explicit doctor') RETURNING id")).rows[0].id;
  const explicitStaffId = (await pool.query("INSERT INTO hr_staff(full_name,department,created_by,hire_date,work_status,contract_kind) VALUES('Synthetic explicit doctor','doctors','test','2026-01-01','active','commission') RETURNING id")).rows[0].id;
  const plan = await reviewHrPersonIdentity(pool, reviewer, [{ key: 'person', staffId: explicitStaffId, expectedRevision: 0,
    fullName: null, userIds: [], partyId, confirmedSamePerson: true, reason: 'Synthetic roster identity proof',
    sourceRef: 'synthetic-roster-proof', closeAccountLinkIds: [], closePartyLinkId: null }]);
  await applyHrPersonIdentityPlan(pool, reviewer, { requestId: 'synthetic-roster-explicit-link', plan });
  await pool.query(`INSERT INTO hr_work_schedules(staff_id,name,effective_from,shift_start_time,shift_end_time,created_by)
    VALUES($1,'Synthetic explicit morning','2026-01-01','08:00','12:00','test')`, [explicitStaffId]);
  expect(await readDoctorClinicalRoster(partyId, '2026-10-21', 'Asia/Aden')).toMatchObject({ status: 'resolved', staffId: explicitStaffId,
    doctorPartyId: partyId, intervals: [{ startTime: '08:00', endTime: '12:00', startDayOffset: 0, endDayOffset: 0 }] });
});
