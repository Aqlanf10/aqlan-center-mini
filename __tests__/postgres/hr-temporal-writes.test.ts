import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { hrTemporalAuthority } from '../../lib/hr-temporal-authority';
import { parseHrHistoryCommand } from '../../lib/hr-temporal-request';
import { recordHrHistory } from '../../lib/hr-temporal-write';
import type { DbPool } from '../../lib/db';
import { readHrRecordedHistory } from '../../lib/hr-temporal-read';
import { readHrPayrollHistory } from '../../lib/hr-payroll-temporal-read';
import { appendHrTimeline } from '../../lib/hr-temporal-store';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>, writers: Pool, actor: SessionPayload;
let runtime: typeof import('../../lib/db');
const originalDatabaseUrl = process.env.DATABASE_URL;
beforeAll(async () => {
  process.env.SESSION_SECRET = 'history-writer-synthetic-secret-0123456789';
  fixture = await openBackupTimestampFixture({ ...process.env });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  runtime = await import('../../lib/db'); await runtime.resetPoolForTesting(); await runtime.ensureSchema();
  for (const file of ['migrations/0056_hr_employment_history.sql', 'migrations/0057_hr_schedule_policy_versions.sql', 'docs/hr-temporal-foundation/proposals/hr-temporal-write-receipts.sql']) await fixture.source.query(await readFile(file, 'utf8'));
  const row = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('history-manager','Synthetic manager','synthetic-hash','admin') RETURNING id")).rows[0];
  actor = { userId: row.id, username: 'history-manager', role: 'admin', expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion('synthetic-hash') };
  writers = new Pool({ connectionString: fixture.source.options.connectionString, max: 8, ssl: false, application_name: 'hr-temporal-writer-tests' });
});
afterAll(async () => { try { await writers?.end(); await runtime?.resetPoolForTesting(); } finally { process.env.DATABASE_URL = originalDatabaseUrl; await fixture?.close(); } });
async function staff() { return Number((await fixture.source.query("INSERT INTO hr_staff(full_name,created_by,hire_date) VALUES('Synthetic history employee','test','2020-01-01') RETURNING id")).rows[0].id); }
function command(id: number, requestId = `document-start-request-${id}`, expectedRevision = 0, supersedeIds: string[] = [], status = 'active') {
  return parseHrHistoryCommand({ requestId, expectedUsername: actor.username, expectedRevision, supersedeIds, reason: 'Synthetic documented decision', append: [{ id: `fact-${requestId}`, kind: 'known', from: '2026-10-01', to: null, value: { status } }] }, 'employment', id);
}
async function counts(id: number) {
  return (await fixture.source.query(`SELECT (SELECT count(*)::int FROM hr_effective_revisions r JOIN hr_effective_streams s ON s.id=r.stream_id WHERE s.staff_id=$1) AS revisions,
    (SELECT count(*)::int FROM hr_temporal_write_receipts WHERE staff_id=$1) AS receipts,
    (SELECT count(*)::int FROM audit_log WHERE entity='hr_effective_revision' AND details->>'staffId'=$1::text) AS audits`, [id])).rows[0];
}
it('simultaneous same-key requests create exactly one revision/audit/receipt and identical results', async () => {
  const id = await staff(), input = command(id), authority = hrTemporalAuthority(actor);
  const [a, b] = await Promise.all([recordHrHistory(writers, authority, input), recordHrHistory(writers, authority, input)]);
  expect(a).toEqual(b); expect(await counts(id)).toEqual({ revisions: 1, receipts: 1, audits: 1 });
  expect((await fixture.source.query('SELECT work_status,hire_date::text FROM hr_staff WHERE id=$1', [id])).rows[0]).toEqual({ work_status: 'active', hire_date: '2020-01-01' });
});
it('captures immutable complete intent before awaiting even the database connection', async () => {
  const id = await staff(), original = command(id);
  const mutable = { ...original, append: original.append.map(fact => ({ ...fact, value: { ...fact.value } })) };
  let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
  const held: DbPool = { query: writers.query.bind(writers), connect: async () => { await gate; return writers.connect(); } };
  const request = recordHrHistory(held, hrTemporalAuthority(actor), mutable);
  mutable.reason = 'Changed after first await'; mutable.append[0].value = { status: 'ended' }; resume();
  const receipt = await request; expect(receipt.intent).toEqual(original); expect(receipt.timeline.facts[0].value).toEqual({ status: 'active' });
});
it('returns the original exact receipt after an intervening revision and rejects changed intent or another subject', async () => {
  const id = await staff(), input = command(id), authority = hrTemporalAuthority(actor);
  const original = await recordHrHistory(writers, authority, input); // Response may be lost after COMMIT.
  await recordHrHistory(writers, authority, command(id, 'document-change-request-0002', 1, [input.append[0].id], 'suspended'));
  expect(await recordHrHistory(writers, authority, input)).toEqual(original);
  await expect(recordHrHistory(writers, authority, { ...input, reason: 'Changed intent' })).rejects.toMatchObject({ code: 'request_reused' });
  await expect(recordHrHistory(writers, authority, { ...input, staffId: await staff() })).rejects.toMatchObject({ code: 'request_reused' });
  expect(await counts(id)).toEqual({ revisions: 2, receipts: 2, audits: 2 });
});
it('serializes competing corrections and rolls back the stale expected revision without a receipt', async () => {
  const id = await staff(), first = command(id), authority = hrTemporalAuthority(actor);
  await recordHrHistory(writers, authority, first);
  const outcomes = await Promise.allSettled(['a', 'b'].map(suffix => recordHrHistory(writers, authority, command(id, `competing-correction-${suffix}`, 1, [first.append[0].id], 'ended'))));
  expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(o => o.status === 'rejected').map(o => o.reason.code)).toEqual(['stale_revision']);
  expect(await counts(id)).toEqual({ revisions: 2, receipts: 2, audits: 2 });
});
it.each(['INSERT INTO hr_effective_streams', 'INSERT INTO hr_effective_revisions', 'INSERT INTO audit_log', 'INSERT INTO hr_temporal_write_receipts'])('fault at %s rolls every write back', async statement => {
  const id = await staff();
  const failing: DbPool = { query: writers.query.bind(writers), connect: async () => {
    const client = await writers.connect(); return { release: () => client.release(), query: async <T>(sql: string, values?: unknown[]) => {
      if (sql.startsWith(statement)) throw new Error('Synthetic injected write fault');
      const result = await client.query(sql, values); return { rows: result.rows as T[], rowCount: result.rowCount };
    } };
  } };
  await expect(recordHrHistory(failing, hrTemporalAuthority(actor), command(id))).rejects.toThrow(/Synthetic injected/);
  expect(await counts(id)).toEqual({ revisions: 0, receipts: 0, audits: 0 });
  expect((await fixture.source.query('SELECT count(*)::int AS n FROM hr_effective_streams WHERE staff_id=$1', [id])).rows[0].n).toBe(0);
});
it('refuses unauthenticated, non-admin and fabricated authority objects before history can leak', async () => {
  const id = await staff();
  await expect(recordHrHistory(writers, hrTemporalAuthority({ ...actor, credentialVersion: 'forged' }), command(id))).rejects.toMatchObject({ code: 'authority_changed' });
  await expect(recordHrHistory(writers, hrTemporalAuthority({ ...actor, role: 'doctor' }), command(id))).rejects.toMatchObject({ code: 'authority_changed' });
  await expect(recordHrHistory(writers, { verify: async () => actor, assertCurrent() {} }, command(id))).rejects.toMatchObject({ code: 'untrusted_authority' });
  expect(await counts(id)).toEqual({ revisions: 0, receipts: 0, audits: 0 });
});

async function waitingOnLock() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows: [row] } = await fixture.source.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='hr-temporal-writer-tests' AND wait_event_type='Lock') AS waiting");
    if (row.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Writer did not reach the real PostgreSQL lock wait');
}
it.each(['role', 'password', 'inactive'])('revalidates %s changes committed while waiting on the authority lock', async field => {
  const username = `history-${field}`, passwordHash = 'synthetic-wait-hash';
  const { rows: [user] } = await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic wait actor',$2,'admin') RETURNING id", [username, passwordHash]);
  const session = { ...actor, userId: user.id, username, credentialVersion: sessionCredentialVersion(passwordHash) }, id = await staff();
  const blocker = await writers.connect(); await blocker.query('BEGIN');
  try {
    await blocker.query(`UPDATE users SET ${field === 'role' ? "role='doctor'" : field === 'password' ? "password_hash='replacement-hash'" : 'is_active=false'} WHERE id=$1`, [user.id]);
    const pending = recordHrHistory(writers, hrTemporalAuthority(session), command(id)).then(value => ({ value }), error => ({ error }));
    await waitingOnLock(); await blocker.query('COMMIT');
    expect(await pending).toMatchObject({ error: { code: 'authority_changed' } });
    expect(await counts(id)).toEqual({ revisions: 0, receipts: 0, audits: 0 });
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});
it.each(['expiry', 'cancel'])('rechecks %s after a real staff-lock wait and rolls the transaction back', async mode => {
  const id = await staff(), controller = new AbortController();
  const session = { ...actor, expiresAt: mode === 'expiry' ? Date.now() + 600 : actor.expiresAt };
  const blocker = await writers.connect(); await blocker.query('BEGIN');
  try {
    await blocker.query('SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE', [id]);
    const pending = recordHrHistory(writers, hrTemporalAuthority(session, controller.signal), command(id)).then(value => ({ value }), error => ({ error }));
    await waitingOnLock();
    if (mode === 'cancel') controller.abort(); else await new Promise(resolve => setTimeout(resolve, Math.max(0, session.expiresAt - Date.now() + 30)));
    await blocker.query('COMMIT');
    expect(await pending).toMatchObject({ error: { code: mode === 'cancel' ? 'request_cancelled' : 'session_expired' } });
    expect(await counts(id)).toEqual({ revisions: 0, receipts: 0, audits: 0 });
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
});
it('does not return a history or replay snapshot after the admitted credential loses authority', async () => {
  const username = 'history-revoked', passwordHash = 'synthetic-revoked-hash';
  const { rows: [user] } = await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic revoked actor',$2,'admin') RETURNING id", [username, passwordHash]);
  const session = { ...actor, userId: user.id, username, credentialVersion: sessionCredentialVersion(passwordHash) }, id = await staff();
  const input = { ...command(id), expectedUsername: username }, authority = hrTemporalAuthority(session); await recordHrHistory(writers, authority, input);
  await fixture.source.query("UPDATE users SET role='doctor' WHERE id=$1", [user.id]);
  await expect(recordHrHistory(writers, authority, input)).rejects.toMatchObject({ code: 'authority_changed' });
  await expect(readHrRecordedHistory(writers, authority, id, 'employment')).rejects.toMatchObject({ code: 'authority_changed' });
});
it('preserves unknown legacy observations, earlier recorded snapshots and future status across the local date boundary', async () => {
  const id = await staff(), authority = hrTemporalAuthority(actor);
  expect(await readHrRecordedHistory(writers, authority, id, 'employment')).toMatchObject({ timeline: { revision: 0, facts: [] }, selected: { kind: 'unknown' }, legacyObservation: { kind: 'unknown', hireDate: '2020-01-01' } });
  const initial = command(id), first = await recordHrHistory(writers, authority, initial);
  const next = parseHrHistoryCommand({ requestId: `future-status-${id}-0001`, expectedUsername: actor.username, expectedRevision: 1, reason: 'Explicit future suspension and reactivation', supersedeIds: [initial.append[0].id], append: [
    { id: 'documented-past', kind: 'known', from: '2026-10-01', to: '2026-11-01', value: { status: 'active' } },
    { id: 'documented-future', kind: 'known', from: '2026-11-01', to: '2026-11-02', value: { status: 'suspended' } },
    { id: 'documented-return', kind: 'known', from: '2026-11-02', to: null, value: { status: 'active' } },
  ] }, 'employment', id);
  await recordHrHistory(writers, authority, next);
  expect((await readHrRecordedHistory(writers, authority, id, 'employment', { revision: 1 })).timeline).toEqual(first.timeline);
  for (const [day, status] of [['2026-10-31', 'active'], ['2026-11-01', 'suspended'], ['2026-11-02', 'active']]) expect(await readHrRecordedHistory(writers, authority, id, 'employment', { day })).toMatchObject({ selected: { kind: 'known', fact: { value: { status } } }, activation: 'documented_only' });
  expect((await fixture.source.query('SELECT work_status FROM hr_staff WHERE id=$1', [id])).rows[0].work_status).toBe('active');
  const hr = await import('../../lib/hr');
  expect(await hr.updateStaff(id, { workStatus: 'ended', reason: 'Legacy bypass attempt' }, actor)).toMatchObject({ ok: false, status: 409 });
  expect(await hr.updateStaff(id, { jobTitle: 'Updated ordinary profile', reason: 'Ordinary profile edit' }, actor)).toMatchObject({ ok: true });
});
it('does not falsely label a committed but lost response as a no-write refusal and replays exactly once', async () => {
  const id = await staff(), input = command(id), authority = hrTemporalAuthority(actor);
  const lost: DbPool = { query: writers.query.bind(writers), connect: async () => {
    const client = await writers.connect(); return { release: () => client.release(), query: async <T>(sql: string, values?: unknown[]) => {
      const result = await client.query(sql, values);
      if (sql === 'COMMIT') throw new Error('Synthetic response loss after actual COMMIT');
      return { rows: result.rows as T[], rowCount: result.rowCount };
    } };
  } };
  await expect(recordHrHistory(lost, authority, input)).rejects.toThrow('Synthetic response loss');
  expect(await counts(id)).toEqual({ revisions: 1, receipts: 1, audits: 1 });
  const replay = await recordHrHistory(writers, authority, input); expect(replay.revision).toBe(1);
  expect(await counts(id)).toEqual({ revisions: 1, receipts: 1, audits: 1 });
});
it('rejects foreign-owner intent before both first execution and durable replay without choosing authority from the body', async () => {
  const id = await staff(), input = command(id), authority = hrTemporalAuthority(actor);
  await expect(recordHrHistory(writers, authority, { ...input, expectedUsername: 'another-administrator' })).rejects.toMatchObject({ code: 'owner_changed', status: 403 });
  expect(await counts(id)).toEqual({ revisions: 0, receipts: 0, audits: 0 });
  await recordHrHistory(writers, authority, input);
  await expect(recordHrHistory(writers, authority, { ...input, expectedUsername: 'another-administrator' })).rejects.toMatchObject({ code: 'owner_changed', status: 403 });
  expect(await counts(id)).toEqual({ revisions: 1, receipts: 1, audits: 1 });
});
it('serializes a legacy PATCH queued behind the first history append and rejects the bypass after append commits', async () => {
  const id = await staff(), hr = await import('../../lib/hr'); let locked!: () => void, resume!: () => void;
  const acquired = new Promise<void>(resolve => { locked = resolve; }), proceed = new Promise<void>(resolve => { resume = resolve; });
  const held: DbPool = { query: writers.query.bind(writers), connect: async () => {
    const client = await writers.connect(); return { release: () => client.release(), query: async <T>(sql: string, values?: unknown[]) => {
      const result = await client.query(sql, values);
      if (sql === 'SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE') { locked(); await proceed; }
      return { rows: result.rows as T[], rowCount: result.rowCount };
    } };
  } };
  const history = recordHrHistory(held, hrTemporalAuthority(actor), command(id)); await acquired;
  const legacy = hr.updateStaff(id, { workStatus: 'ended', reason: 'Synthetic queued legacy update' }, actor);
  try {
    const deadline = Date.now() + 5000; let waiting = false;
    while (Date.now() < deadline) {
      waiting = (await fixture.source.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%hr_staff%') AS waiting")).rows[0].waiting;
      if (waiting) break; await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(true);
  } finally { resume(); }
  expect((await history).revision).toBe(1); expect(await legacy).toMatchObject({ ok: false, status: 409 });
  expect((await fixture.source.query('SELECT work_status FROM hr_staff WHERE id=$1', [id])).rows[0].work_status).toBe('active');
});
it('allows a legacy change committed first, then documents the first history without fabricating prior effective dates', async () => {
  const id = await staff(), hr = await import('../../lib/hr'), blocker = await writers.connect();
  await fixture.source.query(`CREATE FUNCTION synthetic_history_legacy_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id=${id} THEN PERFORM pg_advisory_xact_lock(886543210); END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_history_legacy_wait BEFORE UPDATE ON hr_staff FOR EACH ROW EXECUTE FUNCTION synthetic_history_legacy_wait()`);
  await blocker.query('SELECT pg_advisory_lock(886543210)');
  try {
    const legacy = hr.updateStaff(id, { workStatus: 'suspended', reason: 'Synthetic legacy update starts first' }, actor);
    const deadline = Date.now() + 5000; let waiting = false;
    while (Date.now() < deadline) {
      waiting = (await fixture.source.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory') AS waiting")).rows[0].waiting;
      if (waiting) break; await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(true);
    const history = recordHrHistory(writers, hrTemporalAuthority(actor), command(id)); await waitingOnLock();
    await blocker.query('SELECT pg_advisory_unlock(886543210)');
    expect(await legacy).toMatchObject({ ok: true }); expect((await history).revision).toBe(1);
    const before = await readHrRecordedHistory(writers, hrTemporalAuthority(actor), id, 'employment', { day: '2026-09-30' });
    expect(before.selected.kind).toBe('unknown'); expect(before.legacyObservation.workStatus).toBe('suspended');
  } finally { await blocker.query('SELECT pg_advisory_unlock(886543210)'); blocker.release(); await fixture.source.query('DROP TRIGGER synthetic_history_legacy_wait ON hr_staff; DROP FUNCTION synthetic_history_legacy_wait()'); }
});
it('keeps receipt rows append-only even against direct SQL update, delete and truncate', async () => {
  const id = await staff(); await recordHrHistory(writers, hrTemporalAuthority(actor), command(id));
  for (const sql of ["UPDATE hr_temporal_write_receipts SET response='{}' WHERE staff_id=$1", 'DELETE FROM hr_temporal_write_receipts WHERE staff_id=$1', 'TRUNCATE hr_temporal_write_receipts']) {
    await expect(fixture.source.query(sql, sql.includes('$1') ? [id] : [])).rejects.toThrow(/append.only|immutable/i);
  }
  expect(await counts(id)).toEqual({ revisions: 1, receipts: 1, audits: 1 });
});
it('reads selected correction metadata beyond the newest fifty records without substituting current facts', async () => {
  const id = await staff(), authority = hrTemporalAuthority(actor); let prior: string[] = [];
  for (let revision = 0; revision < 52; revision++) {
    const request = command(id, `recorded-history-${id}-${revision}`, revision, prior, revision % 2 ? 'suspended' : 'active');
    await recordHrHistory(writers, authority, request); prior = [request.append[0].id];
  }
  const result = await readHrRecordedHistory(writers, authority, id, 'employment', { revision: 1 });
  expect(result.records).toHaveLength(50); expect(result.hasMoreRecords).toBe(true);
  expect(result.timeline.revision).toBe(1); expect(result.headRevision).toBe(52);
  expect(result.selectedRecord).toMatchObject({ revision: 1, previousRevision: 0, actorUserId: actor.userId, appendedIds: [`fact-recorded-history-${id}-0`] });
});
it('pins policy revisions to one PostgreSQL snapshot despite a policy revision committed during the read', async () => {
  const id = await staff(); let changed = false;
  const interleaved: DbPool = { query: writers.query.bind(writers), connect: async () => {
    const client = await writers.connect(); return { release: () => client.release(), query: async <T>(sql: string, values?: unknown[]) => {
      const result = await client.query(sql, values);
      if (!changed && sql.startsWith('SELECT r.snapshot') && values?.[0] === 'employment') {
        changed = true;
        await appendHrTimeline(writers, { kind: 'policy', subjectKey: 'proration' }, { expectedRevision: 0, supersedeIds: [], reason: 'Synthetic concurrent configured policy', append: [{ id: 'policy-concurrent', kind: 'known', from: '2026-10-01', to: null, value: { key: 'proration', approval: { state: 'unapproved' }, parameters: {} } }] }, actor.userId!);
      }
      return { rows: result.rows as T[], rowCount: result.rowCount };
    } };
  } };
  const during = await readHrPayrollHistory(interleaved, hrTemporalAuthority(actor), id, '2026-10-01', '2026-11-01');
  expect(changed).toBe(true); expect(during.pinnedRevisions.proration).toBe(0);
  expect((await readHrPayrollHistory(writers, hrTemporalAuthority(actor), id, '2026-10-01', '2026-11-01')).pinnedRevisions.proration).toBe(1);
});
it('leaves frozen approved and closed payroll, liabilities and expenses byte-equivalent in each independent currency', async () => {
  const id = await staff(), authority = hrTemporalAuthority(actor);
  const period = (await fixture.source.query("INSERT INTO hr_payroll_periods(period_key,name,start_date,end_date,status,created_by) VALUES('2026-10','Synthetic frozen','2026-10-01','2026-10-31','closed','test') RETURNING id")).rows[0].id;
  for (const currency of ['YER', 'SAR', 'USD']) {
    const run = (await fixture.source.query("INSERT INTO hr_payroll_runs(period_id,currency,status,total_net_due_minor,total_paid_minor,total_remaining_minor,created_by,approved_by,approved_at) VALUES($1,$2,$3,10000,3000,7000,'test','test',NOW()) RETURNING id", [period, currency, currency === 'USD' ? 'closed' : 'approved'])).rows[0].id;
    await fixture.source.query("INSERT INTO hr_payroll_items(run_id,staff_id,currency,base_salary_minor,net_due_minor,paid_minor,remaining_minor,status,pay_terms_snapshot) VALUES($1,$2,$3,10000,10000,3000,7000,'partially_paid',$4)", [run, id, currency, JSON.stringify({ kind: 'synthetic-frozen-proof', currency, salaryMinor: 10000 })]);
  }
  const tables = ['hr_payroll_periods', 'hr_payroll_runs', 'hr_payroll_items', 'hr_payroll_disbursements', 'payables', 'expenses', 'payments'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table, (await fixture.source.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]')::text AS data FROM ${table} t`)).rows[0].data])));
  const before = await snapshot(); await recordHrHistory(writers, authority, command(id, 'history-frozen-period-proof', 0, [], 'suspended'));
  const result = await readHrPayrollHistory(writers, authority, id, '2026-10-01', '2026-11-01'); expect(result.operationalReady).toBe(false);
  expect(await snapshot()).toEqual(before);
});
