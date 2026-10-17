import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { HR_STAFF_SQL } from '../../lib/hr-schema';
import { appendHrTimeline, readHrTimeline, type HrTemporalStream } from '../../lib/hr-temporal-store';
import { selectTemporal, type TemporalFact } from '../../lib/hr-temporal';
import { assessHrCalculation, type EmploymentFact, type HrEffectivePolicy } from '../../lib/hr-effective-policy';
import { selectHrSchedule, type HrEffectiveSchedule } from '../../lib/hr-schedule-segments';
import type { SessionPayload } from '../../lib/auth';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let writers: Pool, db: typeof import('../../lib/db'), payroll: typeof import('../../lib/hr-payroll');
let actor: SessionPayload, sql56: string, sql57: string, oldFinance: unknown, oldItem: number, oldPayout: number;
const known = <T>(id: string, from: string, to: string | null, value: T): TemporalFact<T> => ({ id, kind: 'known', from, to, value });
const active = (id = 'active') => known<EmploymentFact>(id, '2026-08-01', '2026-09-01', { status: 'active' });
const change = <T>(append: readonly TemporalFact<T>[], expectedRevision = 0, supersedeIds: string[] = []) => ({ append, expectedRevision, supersedeIds, reason: 'Synthetic documented decision' });
async function employee(): Promise<HrTemporalStream> {
  const { rows: [staff] } = await fixture.source.query("INSERT INTO hr_staff(full_name,created_by) VALUES ('Temporal synthetic staff','test') RETURNING id");
  return { kind: 'employment', subjectKey: String(staff.id) };
}
async function financeSnapshot() {
  const snapshot: Record<string, unknown> = {};
  for (const table of ['hr_payroll_periods', 'hr_payroll_runs', 'hr_payroll_items', 'hr_payroll_disbursements', 'payables', 'expenses', 'commissions', 'commission_adjustments', 'journal_entries', 'journal_lines']) {
    if ((await fixture.source.query('SELECT to_regclass($1) AS name', [table])).rows[0].name) snapshot[table] = (await fixture.source.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows;
  }
  return snapshot;
}
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SESSION_SECRET = 'temporal-synthetic-session-secret-0123456789'; process.env.SKIP_SEED = 'false';
  // This additive-migration test deliberately starts before the temporal extension.
  // Only fixture bootstrap is withheld; all original financial/history assertions remain.
  const migrationRuntime = await import('../../lib/migrations');
  const actualApply=migrationRuntime.applyRuntimeMigrationFiles;
  const legacyBootstrap = vi.spyOn(migrationRuntime, 'applyRuntimeMigrationFiles').mockImplementation((pool,files)=>
    files.some(file=>file.version==='0056')?Promise.resolve([]):actualApply(pool,files));
  db = await import('../../lib/db'); await db.resetPoolForTesting();
  try { await db.ensureSchema(); } finally { legacyBootstrap.mockRestore(); }
  const { sessionCredentialVersion } = await import('../../lib/auth');
  const { rows: [user] } = await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES ('temporal-manager','Temporal Manager','synthetic','admin') RETURNING *");
  actor = { userId: user.id, username: user.username, role: 'admin', expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion(user.password_hash) };
  const hr = await import('../../lib/hr'); payroll = await import('../../lib/hr-payroll');
  const period = await payroll.getOrCreatePayrollPeriod('2026-08', actor);
  await db.openShift({ openedBy: actor.username, opening: { YER: 100000, SAR: 10000, USD: 10000 } });
  // Build real legacy approved liabilities and a partial payment before applying either new SQL file.
  for (const currency of ['YER', 'SAR', 'USD'] as const) {
    const staff = await hr.createStaff({ fullName: `Historical salary ${currency}`, department: 'secretariat', jobTitle: 'Reception', hireDate: '2026-01-01', endDate: null, workStatus: 'active', contractKind: 'salary', phone: null, note: null, payTerms: { amountMinor: 100000, currency, period: 'monthly', effectiveOn: '2026-01-01' } }, actor);
    const run = await payroll.calculatePayrollRun(period.id, currency, actor); await payroll.approvePayrollRun(run.id, actor);
    const item = (await payroll.listPayrollItems(run.id)).find(item => item.staffId === staff.id)!;
    expect(item.netDueMinor).toBe(100000);
    if (currency === 'YER') {
      oldItem = item.id;
      oldPayout = (await payroll.disbursePayrollItem(item.id, { amountMinor: 1000, paymentMethod: 'cash', clientRequestId: 'temporal-old-partial-0001' }, actor)).id;
    }
  }
  oldFinance = await financeSnapshot();
  sql56 = await readFile('migrations/0056_hr_employment_history.sql', 'utf8');
  sql57 = await readFile('migrations/0057_hr_schedule_policy_versions.sql', 'utf8');
  await fixture.source.query(sql56); await fixture.source.query(sql57);
  writers = new Pool({ connectionString: fixture.source.options.connectionString, max: 4, ssl: false });
  for (const target of [fixture.sqlTarget, fixture.archiveTarget]) {
    await target.query(await readFile('migrations/0001_baseline_schema.sql', 'utf8'));
    await target.query(HR_STAFF_SQL); await target.query(sql56);
    if (target === fixture.sqlTarget) await target.query(sql57);
    await target.query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES ($1,'temporal-manager','Temporal Manager','synthetic','admin')", [actor.userId]);
  }
}, 60000);
afterAll(async () => { try { await writers?.end(); await db?.resetPoolForTesting(); } finally { await fixture?.close(); } });

it('does not backfill old effective dates, alter current staff, or rewrite any approved monetary snapshot', async () => {
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM hr_effective_revisions')).rows[0].n).toBe(0);
  expect(await financeSnapshot()).toEqual(oldFinance);
  expect((await fixture.source.query('SELECT currency,net_due_minor,paid_minor,remaining_minor FROM hr_payroll_items ORDER BY currency')).rows).toEqual([
    { currency: 'SAR', net_due_minor: '100000', paid_minor: '0', remaining_minor: '100000' },
    { currency: 'USD', net_due_minor: '100000', paid_minor: '0', remaining_minor: '100000' },
    { currency: 'YER', net_due_minor: '100000', paid_minor: '1000', remaining_minor: '99000' },
  ]);
});
it('applies 0056 before 0057 without placeholder migrations and admits policy streams only after 0057', async () => {
  await fixture.archiveTarget.query("INSERT INTO hr_staff(id,full_name,created_by) VALUES(4001,'Migration boundary employee','test')");
  const stream: HrTemporalStream = { kind: 'employment', subjectKey: '4001' };
  await appendHrTimeline(fixture.archiveTarget, stream, change([active()]), actor.userId!);
  await expect(fixture.archiveTarget.query("INSERT INTO hr_effective_streams(kind,subject_key) VALUES('policy','proration')")).rejects.toMatchObject({ code: '23514' });
  await fixture.archiveTarget.query(sql57);
  expect((await readHrTimeline(fixture.archiveTarget, stream)).revision).toBe(1);
  expect((await fixture.archiveTarget.query("INSERT INTO hr_effective_streams(kind,subject_key) VALUES('policy','proration') RETURNING id")).rows).toHaveLength(1);
});
it('preserves unknown observations and selects only documented effective history', async () => {
  const stream = await employee();
  const first = await appendHrTimeline<EmploymentFact>(writers, stream, change([{ id: 'observed', kind: 'unknown', value: { status: 'suspended' } }]), actor.userId!);
  expect(selectTemporal(first, '2026-08-15').kind).toBe('unknown');
  const second = await appendHrTimeline(writers, stream, change([active()], 1), actor.userId!);
  expect(selectTemporal(second, '2026-08-15')).toMatchObject({ kind: 'known', fact: { value: { status: 'active' } } });
  expect(selectTemporal(second, '2026-10-01').kind).toBe('unknown');
  expect(await readHrTimeline(fixture.source, stream, 1)).toEqual(first);
  expect((await fixture.source.query('SELECT snapshot FROM hr_effective_revisions WHERE stream_id=(SELECT id FROM hr_effective_streams WHERE kind=$1 AND subject_key=$2) ORDER BY revision', [stream.kind, stream.subjectKey])).rows[0].snapshot.facts[0]).not.toHaveProperty('from');
});
it('rolls back an overlapping change and refuses a stale revision without deleting history', async () => {
  const stream = await employee(); const before = await appendHrTimeline(writers, stream, change([active()]), actor.userId!);
  await expect(appendHrTimeline(writers, stream, change([known('conflict', '2026-08-20', null, { status: 'ended' })], 1), actor.userId!)).rejects.toMatchObject({ code: 'overlap' });
  await expect(appendHrTimeline(writers, stream, change([active('late')]), actor.userId!)).rejects.toMatchObject({ code: 'stale_revision' });
  expect(await readHrTimeline(fixture.source, stream)).toEqual(before);
});
it('serializes simultaneous first writes over separate PostgreSQL connections with exactly one winner', async () => {
  const stream = await employee();
  const results = await Promise.allSettled([1, 2].map(i => appendHrTimeline(writers, stream, change([active(`writer-${i}`)]), actor.userId!)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'stale_revision' });
  expect((await readHrTimeline(fixture.source, stream)).revision).toBe(1);
});
it('serializes competing corrections and preserves every recorded pre-correction snapshot', async () => {
  const stream = await employee(), first = await appendHrTimeline(writers, stream, change([active()]), actor.userId!);
  const results = await Promise.allSettled([1, 2].map(i => appendHrTimeline(writers, stream, change([active(`corrected-${i}`)], 1, ['active']), actor.userId!)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await readHrTimeline(fixture.source, stream, 1)).toEqual(first);
  expect((await readHrTimeline(fixture.source, stream)).revision).toBe(2);
});
it('enforces the same concurrent revision exclusion for direct SQL callers', async () => {
  const stream = await employee();
  const { rows: [head] } = await fixture.source.query('INSERT INTO hr_effective_streams(kind,subject_key,staff_id) VALUES($1,$2::text,$2::text::int) RETURNING id', [stream.kind, stream.subjectKey]);
  const a = await writers.connect(), b = await writers.connect();
  try {
    const results = await Promise.allSettled([a, b].map((client, i) => client.query('INSERT INTO hr_effective_revisions(stream_id,revision,previous_revision,actor_user_id,reason,snapshot) VALUES($1,1,0,$2,$3,$4)', [head.id, actor.userId, 'Concurrent SQL decision', JSON.stringify({ revision: 1, facts: [active(`sql-${i}`)] })])));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: '40001' });
  } finally { a.release(); b.release(); }
});
it('database constraints independently reject overlap, dated unknowns, malformed dates and duplicate IDs', async () => {
  const stream = await employee();
  const { rows: [head] } = await fixture.source.query('INSERT INTO hr_effective_streams(kind,subject_key,staff_id) VALUES($1,$2::text,$2::text::int) RETURNING id', [stream.kind, stream.subjectKey]);
  for (const facts of [
    [active(), known('b', '2026-08-10', null, { status: 'ended' })],
    [{ id: 'u', kind: 'unknown', from: '2026-01-01', value: { status: 'active' } }],
    [known('bad', '2026-02-30', null, { status: 'active' })], [active(), active()],
    [known('bad-status', '2026-01-01', null, { status: 'admin' })],
  ]) await expect(fixture.source.query('INSERT INTO hr_effective_revisions(stream_id,revision,previous_revision,actor_user_id,reason,snapshot) VALUES($1,1,0,$2,$3,$4)', [head.id, actor.userId, 'Direct SQL validation', JSON.stringify({ revision: 1, facts })])).rejects.toThrow();
  expect(await readHrTimeline(fixture.source, stream)).toEqual({ revision: 0, facts: [] });
});
it('requires real employee and actor identities and rejects changes to stream identity or recorded history', async () => {
  const stream = await employee(); await appendHrTimeline(writers, stream, change([active()]), actor.userId!);
  await expect(appendHrTimeline(writers, { kind: 'employment', subjectKey: '2147483647' }, change([active()]), actor.userId!)).rejects.toMatchObject({ code: '23503' });
  await expect(appendHrTimeline(writers, await employee(), change([active()]), 2147483647)).rejects.toMatchObject({ code: '23503' });
  for (const sql of ['UPDATE hr_effective_revisions SET reason=reason', 'DELETE FROM hr_effective_revisions', 'UPDATE hr_effective_streams SET subject_key=subject_key', 'DELETE FROM hr_effective_streams', 'TRUNCATE hr_effective_streams,hr_effective_revisions']) await expect(fixture.source.query(sql)).rejects.toThrow(/append-only/);
});
it('does not recycle a retired fact identity or modify its old meaning via direct SQL', async () => {
  const stream = await employee(); await appendHrTimeline(writers, stream, change([active()]), actor.userId!);
  await appendHrTimeline(writers, stream, change([active('replacement')], 1, ['active']), actor.userId!);
  await expect(appendHrTimeline(writers, stream, change([active()], 2, ['replacement']), actor.userId!)).rejects.toThrow(/fact_id_reused/);
  const head = (await fixture.source.query('SELECT id FROM hr_effective_streams WHERE kind=$1 AND subject_key=$2', [stream.kind, stream.subjectKey])).rows[0];
  await expect(fixture.source.query('INSERT INTO hr_effective_revisions(stream_id,revision,previous_revision,actor_user_id,reason,snapshot) VALUES($1,3,2,$2,$3,$4)', [head.id, actor.userId, 'Direct forged replacement', JSON.stringify({ revision: 3, facts: [known('replacement', '2026-08-01', '2026-09-01', { status: 'ended' })] })])).rejects.toThrow(/fact_id_reused/);
});
it('keeps draft or future policy from authorizing the affected salary/leave interval while attendance remains available', async () => {
  const stream: HrTemporalStream = { kind: 'policy', subjectKey: 'employment_pay_effect' };
  const draft: HrEffectivePolicy = { key: 'employment_pay_effect', approval: { state: 'unapproved' }, parameters: { ownerDecisionPending: true } };
  const policy = await appendHrTimeline(writers, stream, change([known('draft', '2026-08-01', null, draft)]), actor.userId!);
  const employment = { revision: 1, facts: [known<EmploymentFact>('s', '2026-08-01', null, { status: 'suspended' })] };
  const input = { from: '2026-08-01', to: '2026-09-01', employment, policies: { employment_pay_effect: policy } };
  expect(assessHrCalculation({ ...input, operation: 'salary_accrual' })).toMatchObject({ ready: false, blockers: [{ code: 'policy_not_approved' }] });
  expect(assessHrCalculation({ ...input, operation: 'leave_entitlement' }).ready).toBe(false);
  expect(assessHrCalculation({ ...input, operation: 'attendance_measurement' }).ready).toBe(true);
  const future = await appendHrTimeline(writers, stream, change([known('draft-past', '2026-08-01', '2026-10-01', draft), known('approved-future', '2026-10-01', null, { ...draft, approval: { state: 'approved' as const, decisionRef: 'synthetic-owner-decision' } })], 1, ['draft']), actor.userId!);
  expect(assessHrCalculation({ ...input, operation: 'salary_accrual', policies: { employment_pay_effect: future } }).ready).toBe(false);
  expect(await readHrTimeline(fixture.source, stream, 1)).toEqual(policy);
});
it('selects versioned overnight schedules without changing an already captured prior occurrence', async () => {
  const staff = await employee(), stream: HrTemporalStream = { ...staff, kind: 'schedule' };
  const value: HrEffectiveSchedule = { timeZone: 'Asia/Aden', workingDays: [0, 1, 2, 3, 4, 5, 6], graceMins: 15, segments: [{ id: 'a', start: '22:00', startDayOffset: 0, end: '02:00', endDayOffset: 1 }, { id: 'b', start: '02:00', startDayOffset: 1, end: '06:00', endDayOffset: 1 }] };
  const first = await appendHrTimeline(writers, stream, change([known('night-old', '2026-08-01', '2026-10-01', value)]), actor.userId!);
  const captured = selectHrSchedule(first, '2026-08-01');
  const next = await appendHrTimeline(writers, stream, change([known('night-new', '2026-10-01', null, { ...value, graceMins: 30 })], 1), actor.userId!);
  expect(selectHrSchedule(next, '2026-08-01')).toMatchObject({ kind: 'selected', factId: 'night-old', graceMins: 15 });
  expect(captured).toMatchObject({ timelineRevision: 1, graceMins: 15 });
  expect(selectHrSchedule(next, '2026-10-01')).toMatchObject({ timelineRevision: 2, graceMins: 30 });
  expect(await readHrTimeline(fixture.source, stream, 1)).toEqual(first);
});
it('checks direct SQL schedule and policy shapes without treating a numeric setting as approval', async () => {
  const staff = await employee();
  const { rows: [schedule] } = await fixture.source.query("INSERT INTO hr_effective_streams(kind,subject_key,staff_id) VALUES('schedule',$1::text,$1::text::int) RETURNING id", [staff.subjectKey]);
  const value: HrEffectiveSchedule = { timeZone: 'Asia/Aden', workingDays: [0, 1], graceMins: 15, segments: [{ id: 'a', start: '22:00', startDayOffset: 0, end: '02:00', endDayOffset: 1 }] };
  for (const invalid of [{ ...value, workingDays: [0, 0] }, { ...value, graceMins: 121 }, { ...value, timeZone: 'Not/AZone' }, { ...value, segments: [value.segments[0], { ...value.segments[0], id: 'b' }] }]) await expect(fixture.source.query('INSERT INTO hr_effective_revisions(stream_id,revision,previous_revision,actor_user_id,reason,snapshot) VALUES($1,1,0,$2,$3,$4)', [schedule.id, actor.userId, 'Invalid raw schedule', JSON.stringify({ revision: 1, facts: [known('s', '2026-01-01', null, invalid)] })])).rejects.toThrow();
  const { rows: [policy] } = await fixture.source.query("INSERT INTO hr_effective_streams(kind,subject_key) VALUES('policy','leave_entitlement') RETURNING id");
  for (const approval of [{ state: 'approved' }, { days: 30 }, null]) await expect(fixture.source.query('INSERT INTO hr_effective_revisions(stream_id,revision,previous_revision,actor_user_id,reason,snapshot) VALUES($1,1,0,$2,$3,$4)', [policy.id, actor.userId, 'No invented approval', JSON.stringify({ revision: 1, facts: [known('p', '2026-01-01', null, { key: 'leave_entitlement', approval, parameters: { days: 30 } })] })])).rejects.toThrow();
});
it('roundtrips all recorded revisions with microsecond audit timestamps into a separately owned schema', async () => {
  for (const staff of (await fixture.source.query('SELECT id,full_name FROM hr_staff ORDER BY id')).rows) await fixture.sqlTarget.query("INSERT INTO hr_staff(id,full_name,created_by) VALUES($1,$2,'restored synthetic fixture')", [staff.id, staff.full_name]);
  const streams = (await fixture.source.query('SELECT * FROM hr_effective_streams ORDER BY id')).rows;
  for (const stream of streams) await fixture.sqlTarget.query('INSERT INTO hr_effective_streams(id,kind,subject_key,staff_id) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4)', [stream.id, stream.kind, stream.subject_key, stream.staff_id]);
  const revisions = (await fixture.source.query('SELECT *,recorded_at::text AS exact_time FROM hr_effective_revisions ORDER BY stream_id,revision')).rows;
  for (const revision of revisions) await fixture.sqlTarget.query('INSERT INTO hr_effective_revisions(stream_id,revision,previous_revision,actor_user_id,reason,recorded_at,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)', [revision.stream_id, revision.revision, revision.previous_revision, revision.actor_user_id, revision.reason, revision.exact_time, JSON.stringify(revision.snapshot)]);
  const restored = (await fixture.sqlTarget.query('SELECT *,recorded_at::text AS exact_time FROM hr_effective_revisions ORDER BY stream_id,revision')).rows;
  expect(restored).toEqual(revisions);
  for (const stream of streams) expect(await readHrTimeline(fixture.sqlTarget, { kind: stream.kind, subjectKey: stream.subject_key })).toEqual(await readHrTimeline(fixture.source, { kind: stream.kind, subjectKey: stream.subject_key }));
  await fixture.sqlTarget.query("SELECT setval(pg_get_serial_sequence('hr_effective_streams','id'),(SELECT MAX(id) FROM hr_effective_streams),true)");
  const fresh = (await fixture.sqlTarget.query("INSERT INTO hr_effective_streams(kind,subject_key) VALUES('policy','proration') RETURNING id")).rows[0];
  expect(Number(fresh.id)).toBeGreaterThan(Math.max(...streams.map(s => Number(s.id))));
});
it('leaves legacy liabilities and every independent currency unchanged after all temporal writes, then permits a real partial-payment reversal', async () => {
  expect(await financeSnapshot()).toEqual(oldFinance);
  await payroll.reversePayrollDisbursement(oldPayout, { reason: 'Synthetic reversal after additive schema only' }, actor);
  const { rows: [item] } = await fixture.source.query('SELECT paid_minor,remaining_minor,net_due_minor FROM hr_payroll_items WHERE id=$1', [oldItem]);
  expect(item).toEqual({ paid_minor: '0', remaining_minor: '100000', net_due_minor: '100000' });
  expect((await fixture.source.query('SELECT currency,net_due_minor,paid_minor FROM hr_payroll_items WHERE currency IN ($1,$2) ORDER BY currency', ['SAR', 'USD'])).rows).toEqual([{ currency: 'SAR', net_due_minor: '100000', paid_minor: '0' }, { currency: 'USD', net_due_minor: '100000', paid_minor: '0' }]);
});
