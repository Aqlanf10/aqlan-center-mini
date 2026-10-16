import { afterAll, beforeAll, expect, it } from 'vitest';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import('../../lib/db'), hr: typeof import('../../lib/hr'), work: typeof import('../../lib/hr-contracts-attendance');
let admin: SessionPayload, reviewer: SessionPayload;
let serial = 0;
const saved = { url: process.env.DATABASE_URL, seed: process.env.SKIP_SEED, max: process.env.DB_POOL_MAX };
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = 'false'; process.env.DB_POOL_MAX = '3';
  db = await import('../../lib/db'); hr = await import('../../lib/hr'); work = await import('../../lib/hr-contracts-attendance');
  await db.resetPoolForTesting(); await db.ensureSchema();
  const actors = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES ('authority-admin','Synthetic manager','synthetic-hash','admin'),('authority-reviewer','Synthetic reviewer','synthetic-hash','admin') RETURNING id,username,role,password_hash")).rows;
  [admin, reviewer] = actors.map(row => ({ userId: row.id, username: row.username, role: row.role, expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion(row.password_hash) }));
});
afterAll(async () => {
  try { await db?.resetPoolForTesting(); await fixture?.close(); }
  finally { process.env.DATABASE_URL = saved.url; process.env.SKIP_SEED = saved.seed; process.env.DB_POOL_MAX = saved.max; }
});
async function employee() {
  return hr.createStaff({ fullName: `Synthetic authority ${++serial}`, department: 'secretariat', jobTitle: 'Reception', hireDate: '2026-01-01', workStatus: 'active', contractKind: 'salary', endDate: null, phone: null, note: null, payTerms: { amountMinor: 80000, currency: 'YER', period: 'monthly', effectiveOn: '2026-01-01' } }, admin);
}
async function pendingCorrection() {
  const staff = await employee();
  const attendance = await work.recordAttendance({ staffId: staff.id, attendanceDate: '2026-08-01', checkIn: '2026-08-01T08:00:00+03:00', checkOut: '2026-08-01T16:00:00+03:00' }, admin);
  const correction = await work.requestAttendanceCorrection({ attendanceRecordId: attendance.id, fieldCorrected: 'check_in', newCheckIn: '2026-08-01T09:00:00+03:00', reason: 'Synthetic requested correction' }, admin);
  return { staff, attendance, correction };
}
async function pendingLeave() {
  const staff = await employee();
  await work.adjustLeaveBalance({ staffId: staff.id, leaveTypeCode: 'annual', year: 2026, allocatedDays: 10 }, admin);
  const request = await work.createLeaveRequest({ staffId: staff.id, leaveTypeCode: 'annual', startDate: '2026-08-10', endDate: '2026-08-10', daysCount: 1, reason: 'Synthetic leave request' }, admin);
  return { staff, request };
}
async function state() {
  const result: Record<string, unknown> = {};
  for (const table of ['hr_attendance_records', 'hr_attendance_corrections', 'hr_leave_balances', 'hr_leave_requests', 'hr_work_schedules', 'audit_log']) {
    result[table] = (await fixture.source.query(`SELECT to_jsonb(t)::text AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
it('revoked administrator cannot approve or replay a correction using a previously admitted session', async () => {
  const { correction } = await pendingCorrection(), before = await state();
  await fixture.source.query('UPDATE users SET is_active=FALSE WHERE id=$1', [reviewer.userId]);
  try {
    await expect(work.decideAttendanceCorrection(correction.id, 'approved', 'Review', reviewer)).rejects.toMatchObject({ status: 401 });
    expect(await state()).toEqual(before);
  } finally { await fixture.source.query('UPDATE users SET is_active=TRUE WHERE id=$1', [reviewer.userId]); }
  await work.decideAttendanceCorrection(correction.id, 'approved', 'Valid review', reviewer);
  const approved = await state();
  await expect(work.decideAttendanceCorrection(correction.id, 'approved', 'Replay', { ...reviewer, expiresAt: 1 })).rejects.toMatchObject({ status: 401 });
  expect(await state()).toEqual(approved);
});
it('a changed manager role cannot approve leave or consume an allocated balance', async () => {
  const { request } = await pendingLeave(), before = await state();
  await fixture.source.query("UPDATE users SET role='reception' WHERE id=$1", [reviewer.userId]);
  try {
    await expect(work.decideLeaveRequest(request.id, 'approved', 'Review', reviewer)).rejects.toMatchObject({ status: 401 });
    expect(await state()).toEqual(before);
  } finally { await fixture.source.query("UPDATE users SET role='admin' WHERE id=$1", [reviewer.userId]); }
});
it('a stale credential cannot allocate leave balance or write its audit', async () => {
  const staff = await employee(), before = await state();
  await expect(work.adjustLeaveBalance({ staffId: staff.id, leaveTypeCode: 'annual', year: 2026, allocatedDays: 20 }, { ...reviewer, credentialVersion: 'revoked' })).rejects.toMatchObject({ status: 401 });
  expect(await state()).toEqual(before);
});
it('expired authority cannot create a correction request', async () => {
  const { attendance } = await pendingCorrection(), before = await state();
  await expect(work.requestAttendanceCorrection({ attendanceRecordId: attendance.id, fieldCorrected: 'check_out', newCheckOut: '2026-08-01T17:00:00+03:00', reason: 'Expired request' }, { ...reviewer, expiresAt: 1 })).rejects.toMatchObject({ status: 401 });
  expect(await state()).toEqual(before);
});
it('expired authority cannot create a work schedule', async () => {
  const staff = await employee(), before = await state();
  await expect(work.createSchedule({ staffId: staff.id, name: 'Expired schedule', scheduleType: 'morning', effectiveFrom: '2026-01-01', workingDays: [0, 1, 2, 3, 4], shiftStartTime: '08:00', shiftEndTime: '16:00' }, { ...admin, expiresAt: 1 })).rejects.toMatchObject({ status: 401 });
  expect(await state()).toEqual(before);
});
it('expired reception cannot record a punch, while valid reception retains its existing authority', async () => {
  const staff = await employee();
  const actor = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES ('authority-reception','Synthetic reception','synthetic-hash','reception') RETURNING id")).rows[0];
  const reception: SessionPayload = { ...admin, userId: actor.id, username: 'authority-reception', role: 'reception' };
  const input = { staffId: staff.id, punchType: 'check_in' as const, punchTime: '2026-08-01T08:00:00+03:00' }, before = await state();
  await expect(work.recordAttendancePunch(input, { ...reception, expiresAt: 1 })).rejects.toMatchObject({ status: 401 });
  expect(await state()).toEqual(before);
  expect((await work.recordAttendancePunch(input, reception)).checkInRaw).toBe('2026-08-01T05:00:00.000Z');
});
it('a linked employee needs a current session to submit their own leave request', async () => {
  const staff = await employee();
  await fixture.source.query('UPDATE hr_staff SET user_id=$1 WHERE id=$2', [reviewer.userId, staff.id]);
  const before = await state();
  await expect(work.createLeaveRequest({ staffId: staff.id, leaveTypeCode: 'annual', startDate: '2026-08-10', endDate: '2026-08-10', daysCount: 1, reason: 'Expired own request' }, { ...reviewer, expiresAt: 1 })).rejects.toMatchObject({ status: 401 });
  expect(await state()).toEqual(before);
});
for (const kind of ['leave', 'correction'] as const) it(`expiry while awaiting a real ${kind} lock rolls back all domain and audit changes`, async () => {
  const input = kind === 'leave' ? await pendingLeave() : await pendingCorrection();
  const before = await state(), expiring = { ...reviewer, expiresAt: Date.now() + 1200 };
  const blocker = await fixture.source.connect();
  let outcome: Promise<{ ok: boolean; error?: unknown }> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE', [input.staff.id]);
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pending = 'request' in input
      ? work.decideLeaveRequest(input.request.id, 'approved', 'Lock expiry', expiring)
      : work.decideAttendanceCorrection(input.correction.id, 'approved', 'Lock expiry', expiring);
    outcome = pending.then(() => ({ ok: true }), error => ({ ok: false, error }));
    let observed = false;
    for (let n = 0; n < 100; n += 1) {
      observed = (await blocker.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked;
      if (observed) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(observed).toBe(true);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiring.expiresAt - Date.now()) + 30));
    await blocker.query('COMMIT');
    expect(await outcome).toMatchObject({ ok: false, error: { status: 401 } });
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await outcome; }
  expect(await state()).toEqual(before);
});
