import { afterAll, beforeAll, expect, it } from 'vitest';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { ensureSchema, getPool, resetPoolForTesting } from '../../lib/db';
import { updateWorkSchedule, type UpdateScheduleInput } from '../../lib/hr-contracts-attendance';
import { readDoctorClinicalRoster } from '../../lib/doctor-clinical-roster';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let actor: SessionPayload;
let sequence = 0;
const keys = ['DATABASE_URL', 'SKIP_SEED', 'DB_POOL_MAX'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));

beforeAll(async () => {
  fixture = await openBackupTimestampFixture(process.env);
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = 'true';
  process.env.DB_POOL_MAX = '4';
  await resetPoolForTesting();
  await ensureSchema();
  const { rows: [user] } = await getPool().query(`INSERT INTO users(username,display_name,password_hash,role)
    VALUES('second_shift_manager','Synthetic schedule manager','synthetic-only','admin') RETURNING id`);
  actor = { userId: user.id, username: 'second_shift_manager', role: 'admin',
    credentialVersion: sessionCredentialVersion('synthetic-only'), expiresAt: Date.now() + 3600000 };
});

afterAll(async () => {
  try { await resetPoolForTesting(); await fixture?.close(); }
  finally { for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  } }
});

async function splitSchedule() {
  const suffix = ++sequence, pool = getPool();
  const { rows: [doctor] } = await pool.query("INSERT INTO parties(kind,name) VALUES('doctor',$1) RETURNING id", [`Synthetic schedule doctor ${suffix}`]);
  const { rows: [user] } = await pool.query(`INSERT INTO users(username,display_name,password_hash,role,party_id)
    VALUES($1,'Synthetic schedule doctor','synthetic-only','doctor',$2) RETURNING id`, [`second_shift_doctor_${suffix}`, doctor.id]);
  const { rows: [staff] } = await pool.query(`INSERT INTO hr_staff(full_name,user_id,department,hire_date,work_status,contract_kind,created_by)
    VALUES('Synthetic schedule doctor',$1,'doctors','2026-01-01','active','commission','test') RETURNING id`, [user.id]);
  const { rows: [schedule] } = await pool.query(`INSERT INTO hr_work_schedules
    (staff_id,name,schedule_type,effective_from,working_days,shift_start_time,shift_end_time,second_shift_start,second_shift_end,created_by)
    VALUES($1,'Synthetic split','split','2026-01-01','[0,1,2,3,4,5,6]','08:00','12:00','16:00','20:00','test') RETURNING id`, [staff.id]);
  await pool.query(`INSERT INTO hr_staff_changes(staff_id,actor,actor_role,action,field,new_value,reason)
    VALUES($1,'test','admin','create','synthetic_marker','retained','Synthetic history sentinel')`, [staff.id]);
  return { id: schedule.id as number, doctorId: doctor.id as number, staffId: staff.id as number };
}

async function snapshot(id: number, staffId: number) {
  const pool = getPool();
  return {
    row: (await pool.query('SELECT * FROM hr_work_schedules WHERE id=$1', [id])).rows[0],
    audit: (await pool.query("SELECT * FROM audit_log WHERE entity='hr_work_schedule' AND entity_id=$1 ORDER BY id", [String(id)])).rows,
    history: (await pool.query('SELECT * FROM hr_staff_changes WHERE staff_id=$1 ORDER BY id', [staffId])).rows,
    attendance: (await pool.query('SELECT * FROM hr_attendance_records WHERE staff_id=$1 ORDER BY id', [staffId])).rows,
  };
}

it('persists explicit null second-shift endpoints when changing a split schedule to continuous morning hours', async () => {
  const schedule = await splitSchedule();
  const before = await snapshot(schedule.id, schedule.staffId);
  const updated = await updateWorkSchedule(schedule.id, {
    scheduleType: 'morning', shiftEndTime: '16:00', secondShiftStart: null, secondShiftEnd: null,
  }, actor);
  expect(updated).toMatchObject({ scheduleType: 'morning', secondShiftStart: null, secondShiftEnd: null });
  expect((await getPool().query('SELECT second_shift_start,second_shift_end FROM hr_work_schedules WHERE id=$1', [schedule.id])).rows[0])
    .toEqual({ second_shift_start: null, second_shift_end: null });
  expect(await readDoctorClinicalRoster(schedule.doctorId, '2026-10-24', 'Asia/Aden')).toMatchObject({
    status: 'resolved', intervals: [{ startTime: '08:00', endTime: '16:00', startDayOffset: 0, endDayOffset: 0 }],
  });
  const after = await snapshot(schedule.id, schedule.staffId);
  expect(after.audit).toHaveLength(1);
  expect(after.audit[0]).toMatchObject({ action: 'hr.schedule.update', actor: actor.username,
    actor_role: 'admin', details: { scheduleId: schedule.id } });
  expect(after.history).toEqual(before.history);
  expect(after.attendance).toEqual(before.attendance);
  const changed = new Set(['schedule_type', 'shift_end_time', 'second_shift_start', 'second_shift_end', 'updated_at']);
  expect(Object.fromEntries(Object.entries(after.row).filter(([key]) => !changed.has(key))))
    .toEqual(Object.fromEntries(Object.entries(before.row).filter(([key]) => !changed.has(key))));
});

it.each([
  { label: 'omitted properties', patch: {} },
  { label: 'explicit undefined properties', patch: { secondShiftStart: undefined, secondShiftEnd: undefined } },
])('preserves second-shift endpoints for an unrelated patch with $label', async ({ patch }) => {
  const schedule = await splitSchedule();
  const updated = await updateWorkSchedule(schedule.id, { name: 'Renamed only', gracePeriodMins: 23, ...patch }, actor);
  expect(updated).toMatchObject({ name: 'Renamed only', gracePeriodMins: 23,
    scheduleType: 'split', shiftStartTime: '08:00', shiftEndTime: '12:00', secondShiftStart: '16:00', secondShiftEnd: '20:00' });
});

it('replaces supplied valid second-shift endpoints without changing the first shift', async () => {
  const schedule = await splitSchedule();
  expect(await updateWorkSchedule(schedule.id, { secondShiftStart: '17:00', secondShiftEnd: '21:00' }, actor))
    .toMatchObject({ scheduleType: 'split', shiftStartTime: '08:00', shiftEndTime: '12:00', secondShiftStart: '17:00', secondShiftEnd: '21:00' });
  expect((await readDoctorClinicalRoster(schedule.doctorId, '2026-10-24', 'Asia/Aden')).intervals)
    .toEqual([{ startTime: '08:00', endTime: '12:00', startDayOffset: 0, endDayOffset: 0 },
      { startTime: '17:00', endTime: '21:00', startDayOffset: 0, endDayOffset: 0 }]);
});

it.each([
  { secondShiftStart: null }, { secondShiftEnd: null },
  { secondShiftStart: null, secondShiftEnd: '21:00' }, { secondShiftStart: '17:00', secondShiftEnd: null },
])('rejects a partial clear without changing the row, audit or history: %j', async patch => {
  const schedule = await splitSchedule(), before = await snapshot(schedule.id, schedule.staffId);
  await expect(updateWorkSchedule(schedule.id, { scheduleType: 'morning', name: 'Must roll back', ...patch }, actor))
    .rejects.toThrow('وقت الوردية غير صالح');
  expect(await snapshot(schedule.id, schedule.staffId)).toEqual(before);
});

it('retains the existing requirement that a split schedule has two complete periods', async () => {
  const schedule = await splitSchedule(), before = await snapshot(schedule.id, schedule.staffId);
  await expect(updateWorkSchedule(schedule.id, { secondShiftStart: null, secondShiftEnd: null }, actor))
    .rejects.toThrow('وقت الوردية غير صالح');
  expect(await snapshot(schedule.id, schedule.staffId)).toEqual(before);
});

it('keeps a used schedule immutable and preserves its nonempty attendance and history', async () => {
  const schedule = await splitSchedule();
  await getPool().query(`INSERT INTO hr_attendance_records(staff_id,schedule_id,attendance_date,check_in_raw,work_minutes,created_by)
    VALUES($1,$2,'2026-10-24','2026-10-24T08:00:00+03:00',240,'test')`, [schedule.staffId, schedule.id]);
  const before = await snapshot(schedule.id, schedule.staffId);
  await expect(updateWorkSchedule(schedule.id, { scheduleType: 'morning', secondShiftStart: null, secondShiftEnd: null }, actor))
    .rejects.toThrow(/مستخدم|تاريخ/);
  expect(await snapshot(schedule.id, schedule.staffId)).toEqual(before);
});

it('rolls back explicit clearing when the canonical audit insert fails', async () => {
  const schedule = await splitSchedule(), before = await snapshot(schedule.id, schedule.staffId);
  // Failure injection exists only in this identity-guarded disposable database.
  await getPool().query(`CREATE FUNCTION synthetic_second_shift_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='hr.schedule.update' THEN RAISE EXCEPTION 'synthetic schedule audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_second_shift_audit_failure BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION synthetic_second_shift_audit_failure()`);
  try {
    await expect(updateWorkSchedule(schedule.id, { scheduleType: 'morning', secondShiftStart: null, secondShiftEnd: null }, actor))
      .rejects.toThrow('synthetic schedule audit failure');
    expect(await snapshot(schedule.id, schedule.staffId)).toEqual(before);
  } finally {
    await getPool().query('DROP TRIGGER synthetic_second_shift_audit_failure ON audit_log; DROP FUNCTION synthetic_second_shift_audit_failure()');
  }
});

async function queuedPatches(id: number, first: UpdateScheduleInput, second: UpdateScheduleInput) {
  const blocker = await getPool().connect();
  const settled = (promise: ReturnType<typeof updateWorkSchedule>) => promise.then(
    value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason: reason as Error }));
  const pending: ReturnType<typeof settled>[] = [];
  const blockedCount = async () => Number((await fixture.source.query(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
    WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0
      AND position('FROM hr_work_schedules' in query)>0`)).rows[0].count);
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM hr_work_schedules WHERE id=$1 FOR UPDATE', [id]);
    pending.push(settled(updateWorkSchedule(id, first, actor)));
    await expect.poll(blockedCount, { timeout: 5000, interval: 10 }).toBe(1);
    pending.push(settled(updateWorkSchedule(id, second, actor)));
    await expect.poll(blockedCount, { timeout: 5000, interval: 10 }).toBe(2);
    // Both real writers are blocked at their row read; no timing-based release.
    await blocker.query('COMMIT');
    return await Promise.all(pending);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await Promise.all(pending);
  }
}

it('preserves the first concurrent patch when the queued patch omits the second period', async () => {
  const schedule = await splitSchedule();
  const results = await queuedPatches(schedule.id,
    { secondShiftStart: '17:00', secondShiftEnd: '21:00' }, { name: 'Concurrent rename', gracePeriodMins: 27 });
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  const after = await snapshot(schedule.id, schedule.staffId);
  expect(after.row).toMatchObject({ name: 'Concurrent rename', grace_period_mins: 27,
    second_shift_start: '17:00', second_shift_end: '21:00', shift_start_time: '08:00', shift_end_time: '12:00' });
  expect(after.audit).toHaveLength(2);
});

it('validates a queued endpoint patch against the committed clear, not the old second period', async () => {
  const schedule = await splitSchedule(), before = await snapshot(schedule.id, schedule.staffId);
  const results = await queuedPatches(schedule.id,
    { scheduleType: 'morning', secondShiftStart: null, secondShiftEnd: null }, { secondShiftStart: '17:00' });
  expect(results[0].status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: 'وقت الوردية غير صالح.' } });
  const after = await snapshot(schedule.id, schedule.staffId);
  expect(after.row).toMatchObject({ schedule_type: 'morning', second_shift_start: null, second_shift_end: null });
  expect(after.audit).toHaveLength(1);
  expect(after.history).toEqual(before.history);
});
