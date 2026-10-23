import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { expect, it } from 'vitest';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { applyRuntimeMigrationFiles, loadMigrationFiles, migrate } from '../../lib/migrations';
import { APPOINTMENT_FOLLOWUP_RETIREMENT_SQL } from '../../lib/appointment-followup-retirement-schema';

const tables = ['users', 'appointment_followup_events', 'appointment_followup_receipts'] as const;
type Table = typeof tables[number];
type Lock = { pid: number; relation: string; mode: string; granted: boolean };
const lockTimeoutMs = 1500; // Diagnostic connection only; published/runtime DDL has no local timeout.
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function setup() {
  const fixture = await openBackupTimestampFixture({ ...process.env });
  try {
    const files = await loadMigrationFiles();
    const retirement = files.find(file => file.version === '0072')!;
    expect(retirement.sql).toBe(APPOINTMENT_FOLLOWUP_RETIREMENT_SQL);
    await migrate(fixture.source, { apply: true, files: files.filter(file => file.version < '0072') });
    await fixture.source.query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(900,'synthetic-ddl','Synthetic DDL','test-only','reception')");
    await fixture.source.query(`INSERT INTO appointment_followups
      (id,source_appointment_id,source_created_at,generation,assignee_user_id,due_at,status,outcome,next_step,revision)
      VALUES(1,1,'946684800.000000',$1,900,'2090-01-01','open','pending','call',2)`, ['a'.repeat(32)]);
    await fixture.source.query(`INSERT INTO appointment_followup_events
      (id,followup_id,revision,actor_user_id,request_id,fingerprint,assignee_user_id,due_at,status,outcome,next_step)
      VALUES(1,1,1,900,'synthetic-ddl-base-request',$1,900,'2090-01-01','open','pending','call')`, ['a'.repeat(64)]);
    return { fixture, retirement };
  } catch (error) { await fixture.close(); throw error; }
}
async function facts(pool: Pool) {
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}
async function record(name: string, value: unknown) {
  const directory = process.env.FOLLOWUP_DDL_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}
async function writeAndHold(client: Client, table: Table) {
  await client.query('BEGIN');
  if (table === 'users') {
    // A display-name write only: no password/session/credential changes.
    await client.query("UPDATE users SET display_name='Synthetic held writer' WHERE id=900");
  } else if (table === 'appointment_followup_events') {
    await client.query(`INSERT INTO appointment_followup_events
      (id,followup_id,revision,actor_user_id,request_id,fingerprint,assignee_user_id,due_at,status,outcome,next_step)
      VALUES(2,1,2,900,'synthetic-ddl-held-event',$1,900,'2090-01-01','open','pending','call')`, ['b'.repeat(64)]);
  } else {
    await client.query(`INSERT INTO appointment_followup_receipts(actor_user_id,request_id,fingerprint,event_id)
      VALUES(900,'synthetic-ddl-base-request',$1,1)`, ['a'.repeat(64)]);
  }
}

it.each(tables)('0072 waits on a real held %s writer, times out atomically, then retries unchanged', async table => {
  const { fixture, retirement } = await setup();
  const url = fixture.source.options.connectionString!;
  const writer = new Client({ connectionString: url, ssl: false });
  const migrator = new Pool({ connectionString: url, ssl: false, max: 1, options: `-c lock_timeout=${lockTimeoutMs}ms -c statement_timeout=10s` });
  let pending: Promise<{ versions?: string[]; error?: unknown }> | undefined;
  try {
    await writer.connect();
    const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const migratorPid = (await migrator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const before = await facts(fixture.source);
    await writeAndHold(writer, table);
    const started = performance.now();
    pending = applyRuntimeMigrationFiles(migrator, [retirement]).then(versions => ({ versions }), error => ({ error }));
    let locks: Lock[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      locks = (await fixture.source.query<Lock>(`SELECT pid, relation::regclass::text AS relation, mode, granted
        FROM pg_locks WHERE relation=$1::regclass AND pid=ANY($2::int[]) ORDER BY pid,mode`, [table, [writerPid, migratorPid]])).rows;
      if (locks.some(lock => lock.pid === migratorPid && !lock.granted)) break;
      await pause(10);
    }
    expect(locks).toContainEqual({ pid: writerPid, relation: table, mode: 'RowExclusiveLock', granted: true });
    expect(locks).toContainEqual({ pid: migratorPid, relation: table, mode: 'ShareRowExclusiveLock', granted: false });
    const blockers = (await fixture.source.query('SELECT pg_blocking_pids($1) AS pids', [migratorPid])).rows[0].pids;
    expect(blockers).toContain(writerPid);
    // AccessShareLock is compatible even while this DDL request is queued.
    const readStarted = performance.now();
    await fixture.source.query(`SELECT count(*) FROM ${table}`);
    const ordinaryReadMs = performance.now() - readStarted;
    const outcome = await pending;
    const elapsedMs = performance.now() - started;
    expect(outcome.error).toMatchObject({ code: '55P03' });
    expect(await facts(fixture.source)).toEqual(before); // Uncommitted writer still held; DDL changed nothing.
    const rolledBack = (await fixture.source.query(`SELECT to_regclass('appointment_followup_retirements') AS table_name,
      to_regprocedure('aqlan_followup_attempt_fence()') AS function_name,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('appointment_followup_event_retirement_fence','appointment_followup_receipt_retirement_fence')) AS triggers,
      (SELECT count(*)::int FROM schema_migrations WHERE version='0072') AS registry_rows`)).rows[0];
    expect(rolledBack).toEqual({ table_name: null, function_name: null, triggers: 0, registry_rows: 0 });
    await writer.query('COMMIT');
    const committedWriterFacts = await facts(fixture.source);
    const retryStarted = performance.now();
    expect(await applyRuntimeMigrationFiles(migrator, [retirement])).toEqual(['0072']);
    const retryMs = performance.now() - retryStarted;
    expect(await facts(fixture.source)).toEqual(committedWriterFacts);
    expect((await fixture.source.query("SELECT checksum FROM schema_migrations WHERE version='0072'")).rows[0].checksum).toBe(retirement.checksum);
    await record(table, { synthetic: true, migrationSha256: retirement.checksum, lockTimeoutMs, elapsedMs, ordinaryReadMs,
      errorCode: '55P03', locks, blockers, rolledBack, retryMs, writerCommitted: true, historyPreserved: true });
  } finally {
    await writer.query('ROLLBACK').catch(() => undefined);
    await pending;
    await writer.end(); await migrator.end(); await fixture.close();
  }
});

it('0072 completes while ordinary readers retain AccessShareLock on all three existing tables', async () => {
  const { fixture, retirement } = await setup();
  const url = fixture.source.options.connectionString!;
  const reader = new Client({ connectionString: url, ssl: false });
  const migrator = new Pool({ connectionString: url, ssl: false, max: 1, options: `-c lock_timeout=${lockTimeoutMs}ms -c statement_timeout=10s` });
  try {
    await reader.connect(); await reader.query('BEGIN');
    const readerPid = (await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    for (const table of tables) await reader.query(`SELECT count(*) FROM ${table}`);
    const locks = (await fixture.source.query<Lock>(`SELECT pid, relation::regclass::text AS relation, mode, granted FROM pg_locks
      WHERE pid=$1 AND relation IN ('users'::regclass,'appointment_followup_events'::regclass,'appointment_followup_receipts'::regclass)
      ORDER BY relation::regclass::text, mode`, [readerPid])).rows;
    for (const table of tables) expect(locks).toContainEqual({ pid: readerPid, relation: table, mode: 'AccessShareLock', granted: true });
    const before = await facts(fixture.source);
    const started = performance.now();
    expect(await applyRuntimeMigrationFiles(migrator, [retirement])).toEqual(['0072']);
    const elapsedMs = performance.now() - started;
    expect(await facts(fixture.source)).toEqual(before);
    expect((await fixture.source.query('SELECT xact_start IS NOT NULL AS open FROM pg_stat_activity WHERE pid=$1', [readerPid])).rows[0].open).toBe(true);
    await record('ordinary-readers', { synthetic: true, migrationSha256: retirement.checksum, lockTimeoutMs, elapsedMs,
      locks, readerTransactionStillOpen: true, historyPreserved: true });
  } finally { await reader.query('ROLLBACK').catch(() => undefined); await reader.end(); await migrator.end(); await fixture.close(); }
});
