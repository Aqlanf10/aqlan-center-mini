import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { validatePostgresTestTarget } from './_safe-target';
import { getPool, ensureSchema, resetPoolForTesting, type DbClient } from '../../lib/db';
import { readDoctorAvailabilityAdvisory } from '../../lib/doctor-availability-advisory';

let admin: Client | undefined, writer: Client | undefined;
let owned: { name: string; oid: string; owner: string } | undefined;
let doctorId: number, staffId: number;
const keys = ['DATABASE_URL', 'SKIP_SEED', 'DB_POOL_MAX', 'SESSION_SECRET'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeAll(async () => {
  const target = validatePostgresTestTarget(process.env);
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  const name = `aqlan_advisory_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  const { rows: [identity] } = await admin.query('SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [name]);
  if (!identity || identity.name !== name) throw new Error('Owned advisory database identity unavailable.');
  owned = identity;
  const url = new URL(target.testUrl); url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.SKIP_SEED = 'true'; process.env.DB_POOL_MAX = '1';
  process.env.SESSION_SECRET = 'synthetic-advisory-test-secret-0123456789';
  await resetPoolForTesting(); await ensureSchema();
  writer = new Client({ connectionString: url.toString(), ssl: false }); await writer.connect();
  const pool = getPool();
  doctorId = (await pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic advisory doctor') RETURNING id")).rows[0].id;
  const userId = (await pool.query("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES('synthetic_advisory','Synthetic advisory','not-a-login-hash','doctor',$1) RETURNING id", [doctorId])).rows[0].id;
  staffId = (await pool.query("INSERT INTO hr_staff(full_name,user_id,department,created_by) VALUES('Synthetic advisory',$1,'doctors','test') RETURNING id", [userId])).rows[0].id;
  await pool.query("INSERT INTO hr_leave_types(code,name_ar,is_paid) VALUES('annual','Synthetic advisory leave',true) ON CONFLICT(code) DO NOTHING");
  await pool.query(`INSERT INTO hr_work_schedules(staff_id,name,effective_from,working_days,shift_start_time,shift_end_time,crosses_midnight,schedule_type,created_by)
    VALUES($1,'Synthetic night','2026-01-01','[0,1,2,3,4,5,6]','22:00','04:00',true,'night','test')`, [staffId]);
});
beforeEach(async () => {
  await writer!.query('DELETE FROM hr_leave_requests WHERE staff_id=$1', [staffId]);
  await writer!.query("UPDATE hr_work_schedules SET shift_end_time='04:00',effective_to=NULL WHERE staff_id=$1", [staffId]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    await writer?.end(); await resetPoolForTesting();
    if (owned && admin) {
      const { rows: [actual] } = await admin.query('SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [owned.name]);
      if (!/^aqlan_advisory_[a-f0-9]{32}$/.test(owned.name) || !actual || actual.name !== owned.name || actual.oid !== owned.oid || actual.owner !== owned.owner)
        throw new Error('Advisory fixture identity changed; cleanup refused.');
      await admin.query(`DROP DATABASE "${owned.name}"`);
    }
  } finally {
    await admin?.end();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

const read = () => readDoctorAvailabilityAdvisory(doctorId, '2026-10-25', 'Asia/Aden');
const windows = [{ start: 0, end: 240 }, { start: 1320, end: 1440 }];

// Test-only interception delegates to a real PostgreSQL client. No production injection API.
async function intercept(wrap: (client: DbClient) => DbClient) {
  const pool = getPool(), client = await pool.connect();
  vi.spyOn(pool, 'connect').mockResolvedValueOnce(wrap(client));
  return client;
}

it('reads both civil-day windows and the final effective-date tail from real HR rows', async () => {
  expect(await read()).toMatchObject({ purpose: 'advisory_only', bookingGuaranteed: false, resolved: true, windows });
  await writer!.query("UPDATE hr_work_schedules SET effective_to='2026-10-24' WHERE staff_id=$1", [staffId]);
  expect(await read()).toMatchObject({ resolved: true, currentAssignmentMissing: true, windows: [{ start: 0, end: 240 }] });
});

it('keeps yesterday and today on one read-only snapshot when another connection changes schedule and leave', async () => {
  let changes = 0;
  await intercept(client => ({
    query: async (sql, values) => {
      const result = await client.query(sql, values);
      if (sql.startsWith('BEGIN')) {
        expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('repeatable read');
        expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');
      }
      // Both anchors use this bulk schedule read; leaves are read afterwards.
      if (/FROM hr_work_schedules WHERE/.test(sql)) {
        changes++;
        await writer!.query('BEGIN');
        try {
          await writer!.query("UPDATE hr_work_schedules SET shift_end_time='02:00' WHERE staff_id=$1", [staffId]);
          await writer!.query(`INSERT INTO hr_leave_requests(staff_id,leave_type_code,start_date,end_date,days_count,reason,status,created_by)
            VALUES($1,'annual','2026-10-25','2026-10-25',1,'Synthetic snapshot test','approved','test')`, [staffId]);
          await writer!.query('COMMIT');
        } catch (error) { await writer!.query('ROLLBACK'); throw error; }
      }
      return result;
    }, release: destroy => client.release(destroy),
  }));
  expect(await read()).toMatchObject({ resolved: true, windows });
  expect(changes).toBe(1);
  expect(await read()).toMatchObject({ resolved: true, windows: [] });
  await writer!.query('DELETE FROM hr_leave_requests WHERE staff_id=$1', [staffId]);
  expect(await read()).toMatchObject({ resolved: true, windows: [{ start: 0, end: 120 }, { start: 1320, end: 1440 }] });
});

it.each([false, true])('releases a failed real transaction, discarding the connection iff rollback fails: %s', async failRollback => {
  const commands: string[] = [], releases: boolean[] = [];
  let originalPid: number | undefined;
  await intercept(client => ({
    query: async (sql, values) => {
      commands.push(sql);
      if (/FROM hr_work_schedules WHERE/.test(sql)) {
        originalPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        // Real server error leaves this transaction aborted.
        return client.query('SELECT 1 / 0');
      }
      if (sql === 'ROLLBACK' && failRollback) throw new Error('Synthetic rollback transport failure');
      return client.query(sql, values);
    },
    release: destroy => { releases.push(destroy === true); client.release(destroy); },
  }));
  await expect(read()).rejects.toMatchObject({ code: '22012' });
  expect(commands.at(-1)).toBe('ROLLBACK');
  expect(commands).not.toContain('COMMIT');
  expect(releases).toEqual([failRollback]);
  const probe = await getPool().connect();
  try {
    const pid = (await probe.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    if (failRollback) expect(pid).not.toBe(originalPid); else expect(pid).toBe(originalPid);
    expect((await probe.query('SELECT 1 AS healthy')).rows[0].healthy).toBe(1);
  } finally { probe.release(); }
  expect(await read()).toMatchObject({ resolved: true, windows });
});
