import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
import { insertAppointmentPurposeProvenance } from '../../lib/appointment-purpose';
import { APPOINTMENT_PURPOSE_MIGRATION, validateAppointmentPurposeMigration } from '../../lib/appointment-purpose-migration-guard';

// This is a native PG18, identity-checked synthetic fixture; never a supplied DB.
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
const priorUrl = process.env.DATABASE_URL, priorSeed = process.env.SKIP_SEED;
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import('../../lib/db');
let directory: string;
let oldAppointment: number, replacement: number, patientId: number, planId: number, plannedVisitId: number;

async function facts(pool: Pool) {
  return (await pool.query(`SELECT p.appointment_id,p.patient_id,p.purpose,p.source_plan_id,
      p.source_planned_visit_id,p.recorded_at::text AS recorded_at,p.recorded_by,
      a.status,a.planned_visit_id AS live_planned_visit_id
    FROM appointment_purpose_provenance p JOIN appointments a ON a.id=p.appointment_id
    ORDER BY p.appointment_id`)).rows;
}

beforeAll(async () => {
  fixture = await openBackupTimestampFixture(process.env);
  directory = await mkdtemp(join(tmpdir(), 'appointment-purpose-restore-'));
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = 'true';
  db = await import('../../lib/db');
  await db.resetPoolForTesting();
  await db.ensureSchema();
  patientId = (await fixture.source.query(`INSERT INTO patients(patient_number,full_name)
    VALUES('SYN-PURPOSE-RESTORE','Synthetic purpose restore patient') RETURNING id`)).rows[0].id;
  planId = (await fixture.source.query(`INSERT INTO treatment_plans(patient_id,title,total_minor,status)
    VALUES($1,'Synthetic immutable source plan',100,'active') RETURNING id`, [patientId])).rows[0].id;
  oldAppointment = (await fixture.source.query(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time)
    VALUES($1,CURRENT_DATE+20,'10:00') RETURNING id`, [patientId])).rows[0].id;
  plannedVisitId = (await fixture.source.query(`INSERT INTO planned_visits(patient_id,plan_id,sequence,title,status,appointment_id)
    VALUES($1,$2,1,'Synthetic planned follow-up','scheduled',$3) RETURNING id`,
    [patientId, planId, oldAppointment])).rows[0].id;
  await fixture.source.query('UPDATE appointments SET planned_visit_id=$2 WHERE id=$1', [oldAppointment, plannedVisitId]);
  const originalClient = await fixture.source.connect();
  try {
    await originalClient.query('BEGIN');
    await insertAppointmentPurposeProvenance(originalClient, { appointmentId: oldAppointment,
      purpose: 'follow_up', sourcePlanId: planId, sourcePlannedVisitId: plannedVisitId,
      recordedBy: 'synthetic-original' });
    await originalClient.query('COMMIT');
  } catch (error) { await originalClient.query('ROLLBACK').catch(() => {}); throw error; }
  finally { originalClient.release(); }
  // Simulate the existing operational rebook-link flip. It must not rewrite the
  // old historical tuple; replacement receives a second explicit tuple.
  await fixture.source.query(`UPDATE appointments SET status='cancelled',planned_visit_id=NULL WHERE id=$1`, [oldAppointment]);
  await fixture.source.query('UPDATE planned_visits SET appointment_id=NULL WHERE id=$1', [plannedVisitId]);
  replacement = (await fixture.source.query(`INSERT INTO appointments(patient_id,scheduled_date,scheduled_time)
    VALUES($1,CURRENT_DATE+21,'11:00') RETURNING id`, [patientId])).rows[0].id;
  await fixture.source.query('UPDATE appointments SET planned_visit_id=$2 WHERE id=$1', [replacement, plannedVisitId]);
  await fixture.source.query('UPDATE planned_visits SET appointment_id=$2 WHERE id=$1', [plannedVisitId, replacement]);
  const nextClient = await fixture.source.connect();
  try {
    await nextClient.query('BEGIN');
    await insertAppointmentPurposeProvenance(nextClient, { appointmentId: replacement,
      purpose: 'follow_up', sourcePlanId: planId, sourcePlannedVisitId: plannedVisitId,
      recordedBy: 'synthetic-rebook' });
    await nextClient.query('COMMIT');
  } catch (error) { await nextClient.query('ROLLBACK').catch(() => {}); throw error; }
  finally { nextClient.release(); }
  const source = await fixture.source.connect();
  try {
    let sql = '';
    for await (const line of db.backupSqlLines(source)) sql += line;
    await writeFile(join(directory, 'purpose.sql'), sql);
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source,
      readDocument: async () => { throw new Error('No synthetic documents expected'); } })) blocks.push(block);
    await writeFile(join(directory, 'purpose.tar.gz'), gzipSync(Buffer.concat(blocks)));
  } finally { source.release(); }
}, 120_000);

afterAll(async () => {
  await db?.resetPoolForTesting();
  if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
  if (priorSeed === undefined) delete process.env.SKIP_SEED; else process.env.SKIP_SEED = priorSeed;
  await fixture?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function verify(target: Pool) {
  const expected = await facts(fixture.source);
  expect(expected).toHaveLength(2);
  expect(expected).toMatchObject([
    { appointment_id: oldAppointment, patient_id: patientId, purpose: 'follow_up',
      source_plan_id: planId, source_planned_visit_id: plannedVisitId,
      status: 'cancelled', live_planned_visit_id: null },
    { appointment_id: replacement, patient_id: patientId, purpose: 'follow_up',
      source_plan_id: planId, source_planned_visit_id: plannedVisitId,
      status: 'booked', live_planned_visit_id: plannedVisitId },
  ]);
  expect(await facts(target)).toEqual(expected);
  const registry = (await target.query("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version='0095'")).rows;
  expect(registry).toMatchObject([{ version: '0095', name: APPOINTMENT_PURPOSE_MIGRATION.name,
    checksum: APPOINTMENT_PURPOSE_MIGRATION.checksum, adopted: false }]);
  const client = await target.connect();
  try { await validateAppointmentPurposeMigration(client, [APPOINTMENT_PURPOSE_MIGRATION], registry); }
  finally { client.release(); }
  await expect(target.query('UPDATE appointment_purpose_provenance SET purpose=purpose WHERE appointment_id=$1',
    [oldAppointment])).rejects.toThrow('immutable');
  await expect(target.query('DELETE FROM treatment_plans WHERE id=$1', [planId])).rejects.toThrow();
  await expect(target.query('TRUNCATE appointment_purpose_provenance')).rejects.toThrow('immutable');
}

it('official SQL restore retains both immutable historical tuples and their owner graph', async () => {
  process.env.DATABASE_URL = fixture.sqlTarget.options.connectionString!;
  await db.resetPoolForTesting();
  await db.ensureSchema();
  const result = await promisify(execFile)(process.execPath,
    ['scripts/restore.mjs', join(directory, 'purpose.sql')], { env: { ...process.env } });
  expect(result.stdout).toContain('تمت الاستعادة');
  await verify(fixture.sqlTarget);
}, 120_000);

it('official full archive staged restore retains the same tuple with guards active', async () => {
  const result = await stagedRestore({ archivePath: join(directory, 'purpose.tar.gz'),
    targetUrl: fixture.archiveTarget.options.connectionString!, stagingDir: join(directory, 'documents') });
  expect(result).toMatchObject({ ok: true, errors: [], validationErrors: [] });
  await verify(fixture.archiveTarget);
}, 120_000);
