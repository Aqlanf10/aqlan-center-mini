import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { openPersonIdentityReviewFixture } from './_hr-person-review-fixture';
import { identityCandidate } from './_hr-identity-candidate';
import { applyRuntimeMigrationFiles } from '../../lib/migrations';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
import { applyHrPersonIdentityPlan, reviewHrPersonIdentity, type PersonIdentityReceipt } from '../../lib/hr-person-identity';
import type { PersonIdentityDecision, PersonIdentityPlan } from '../../lib/hr-person-identity-plan';
import { readPersonIdentitySchema } from '../../lib/hr-person-identity-schema-state';
import { assertPersonMayApprove } from '../../lib/hr-person-identity-approval';
import { RESET_KEEP_TABLES } from '../../lib/clinic-reset';

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
// Only file discovery is substituted. The archive reader, migrator, SQL executor,
// constraints and triggers all run unchanged against owned PostgreSQL databases.
vi.mock('../../lib/migration-files', async (original) => {
  const real = await original<typeof import('../../lib/migration-files')>();
  return { ...real, loadMigrationFiles: async (dir?: string) => [...await real.loadMigrationFiles(dir), identityCandidate()] };
});

const identityTables = ['hr_identity_import_runs', 'hr_identity_events', 'hr_staff_account_links', 'hr_staff_party_links'];
const sequences = ['hr_staff_id_seq', 'hr_identity_events_id_seq', 'hr_staff_account_links_id_seq', 'hr_staff_party_links_id_seq'];
async function rows(pool: Pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations' ORDER BY tablename")).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) result[tablename] = (await pool.query(`SELECT to_jsonb(t) AS value FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}
async function sequenceState(pool: Pool) {
  return Object.fromEntries(await Promise.all(sequences.map(async name => [name,
    (await pool.query(`SELECT last_value::text,is_called FROM "${name}"`)).rows[0]])));
}

describe.each(['before-conversion', 'after-correction'] as const)('%s synthetic restore', phase => {
  let fixture: Awaited<ReturnType<typeof openPersonIdentityReviewFixture>>, directory: string;
  const replays: { requestId: string; plan: PersonIdentityPlan; receipt: PersonIdentityReceipt }[] = [];
  let staffId: number, secondaryId: number;

  beforeAll(async () => {
    fixture = await openPersonIdentityReviewFixture();
    directory = await mkdtemp(join(tmpdir(), 'hr-identity-restore-'));
    const primary = await fixture.account(), secondary = await fixture.account();
    secondaryId = secondary.userId;
    staffId = await fixture.staff(primary.userId);
    const partyId = (await fixture.source.query("INSERT INTO parties(kind,name) VALUES('employee','Synthetic identity party') RETURNING id")).rows[0].id;
    if (phase === 'after-correction') {
      const decision: PersonIdentityDecision = { key: 'person', staffId, expectedRevision: 0, fullName: null,
        userIds: [primary.userId, secondary.userId], partyId, confirmedSamePerson: true,
        reason: 'Synthetic independently reviewed identity', sourceRef: 'synthetic-restore-evidence', closeAccountLinkIds: [], closePartyLinkId: null };
      const plan = await reviewHrPersonIdentity(fixture.db.getPool(), fixture.reviewer, [decision]);
      const requestId = 'restore-original-request';
      replays.push({ requestId, plan, receipt: await applyHrPersonIdentityPlan(fixture.db.getPool(), fixture.reviewer, { requestId, plan }) });
      const accountLink = (await fixture.source.query('SELECT id::text FROM hr_staff_account_links WHERE user_id=$1', [secondary.userId])).rows[0].id;
      const partyLink = (await fixture.source.query('SELECT id::text FROM hr_staff_party_links WHERE staff_id=$1', [staffId])).rows[0].id;
      const replacementParty = (await fixture.source.query("INSERT INTO parties(kind,name) VALUES('employee','Synthetic corrected party') RETURNING id")).rows[0].id;
      const correction = await reviewHrPersonIdentity(fixture.db.getPool(), fixture.reviewer, [{ ...decision,
        expectedRevision: 1, userIds: [primary.userId], partyId: replacementParty,
        closeAccountLinkIds: [accountLink], closePartyLinkId: partyLink }]);
      const correctionId = 'restore-correction-request';
      replays.push({ requestId: correctionId, plan: correction,
        receipt: await applyHrPersonIdentityPlan(fixture.db.getPool(), fixture.reviewer, { requestId: correctionId, plan: correction }) });
      // A closed historical link does not reserve a live account. This valid
      // state must remain restorable without weakening the current-link guard.
      await fixture.staff(secondary.userId);
      // The old, closed financial link can outlive a later party reclassification.
      await fixture.source.query("UPDATE parties SET kind='lab' WHERE id=$1", [partyId]);
      // Deliberately disturb physical order; restore cannot rely on heap order.
      await fixture.source.query('CREATE INDEX synthetic_events_reverse ON hr_identity_events(id DESC); CLUSTER hr_identity_events USING synthetic_events_reverse; DROP INDEX synthetic_events_reverse');
    }
    // Preserve consumed gaps and an uncalled sequence above its initial value.
    await fixture.source.query("SELECT setval('hr_identity_events_id_seq',9007199254740993,true),setval('hr_staff_account_links_id_seq',8000,true),setval('hr_staff_party_links_id_seq',7000,false),setval('hr_staff_id_seq',6000,true)");
    const client = await fixture.source.connect();
    try {
      let sql = ''; for await (const line of fixture.db.backupSqlLines(client)) sql += line;
      await writeFile(join(directory, 'data.sql'), sql);
      const blocks: Uint8Array[] = [];
      for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error('No documents in this fixture'); } })) blocks.push(block);
      await writeFile(join(directory, 'full.tar.gz'), gzipSync(Buffer.concat(blocks)));
    } finally { client.release(); }
  });
  afterAll(async () => {
    await fixture?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function assertRestored(target: Pool) {
    expect(await rows(target)).toEqual(await rows(fixture.source));
    expect(await sequenceState(target)).toEqual(await sequenceState(fixture.source));
    expect(await readPersonIdentitySchema(target)).toBe(await readPersonIdentitySchema(fixture.source));
    for (const replay of replays) expect(await applyHrPersonIdentityPlan(target, fixture.reviewer, { requestId: replay.requestId, plan: replay.plan })).toEqual(replay.receipt);
    expect(await rows(target)).toEqual(await rows(fixture.source));
    expect((await target.query('SHOW session_replication_role')).rows[0].session_replication_role).toBe('origin');
    expect((await target.query("SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'")).rows[0].n).toBe(0);
    if (phase === 'after-correction') {
      await expect(target.query('UPDATE hr_identity_events SET reason=reason')).rejects.toThrow(/append-only/);
      await expect(target.query('DELETE FROM hr_staff_account_links')).rejects.toThrow(/cannot be deleted/);
      await expect(target.query(`INSERT INTO hr_staff_account_links(id,staff_id,user_id,opened_event_id,opened_at,closed_event_id,closed_at)
        SELECT 919191,staff_id,user_id,opened_event_id,opened_at,opened_event_id,closed_at
        FROM hr_staff_account_links WHERE closed_at IS NOT NULL LIMIT 1`)).rejects.toThrow(/closed link requires matching identity event/);
      await expect(target.query(`INSERT INTO hr_staff_account_links(id,staff_id,user_id,opened_event_id,opened_at)
        SELECT 919192,staff_id,user_id,opened_event_id,opened_at
        FROM hr_staff_account_links WHERE closed_at IS NOT NULL LIMIT 1`)).rejects.toMatchObject({ code: '23505' });
      await expect(target.query(`INSERT INTO hr_staff_party_links(id,staff_id,party_id,opened_event_id,opened_at,closed_event_id,closed_at)
        SELECT 919193,staff_id,party_id,opened_event_id,opened_at,opened_event_id,closed_at
        FROM hr_staff_party_links WHERE closed_at IS NOT NULL LIMIT 1`)).rejects.toThrow(/closed link requires matching identity event/);
      await expect(target.query(`INSERT INTO hr_staff_party_links(id,staff_id,party_id,opened_event_id,opened_at)
        SELECT 919194,staff_id,party_id,opened_event_id,opened_at
        FROM hr_staff_party_links WHERE closed_at IS NOT NULL LIMIT 1`)).rejects.toThrow(/doctor or employee/);
      await expect(assertPersonMayApprove(target, { actorUserId: secondaryId, subjectStaffId: staffId, hasRequest: true })).rejects.toMatchObject({ status: 409 });
    }
    const next = (await target.query(`SELECT nextval('hr_staff_id_seq')::text AS staff,
      nextval('hr_identity_events_id_seq')::text AS event,nextval('hr_staff_account_links_id_seq')::text AS account,
      nextval('hr_staff_party_links_id_seq')::text AS party`)).rows[0];
    expect(next).toEqual({ staff: '6001', event: '9007199254740994', account: '8001', party: '7000' });
  }

  it('SQL CLI restores rows, history, sequences and exact receipt replay with guards enabled', async () => {
    process.env.DATABASE_URL = fixture.sqlTarget.options.connectionString!;
    process.env.SKIP_SEED = 'true';
    await fixture.db.resetPoolForTesting(); await fixture.db.ensureSchema();
    await applyRuntimeMigrationFiles(fixture.sqlTarget, [identityCandidate()]);
    const restored = await promisify(execFile)(process.execPath, ['scripts/restore.mjs', join(directory, 'data.sql')], { env: { ...process.env } });
    expect(restored.stdout).toContain('تمت الاستعادة');
    await assertRestored(fixture.sqlTarget);
  });

  it('full archive restore creates its schema on an empty isolated target and preserves history', async () => {
    const restored = await stagedRestore({ archivePath: join(directory, 'full.tar.gz'), targetUrl: fixture.archiveTarget.options.connectionString!, stagingDir: join(directory, 'documents') });
    expect(restored.errors).toEqual([]); expect(restored.validationErrors).toEqual([]); expect(restored.ok).toBe(true);
    await assertRestored(fixture.archiveTarget);
  });

  it('operational reset retains identity history, sequences and replay after making its backup', async () => {
    for (const table of identityTables) expect(RESET_KEEP_TABLES).toContain(table);
    process.env.DATABASE_URL = fixture.source.options.connectionString!;
    process.env.SKIP_SEED = 'true';
    await fixture.db.resetPoolForTesting();
    const before = await rows(fixture.source), beforeSequences = await sequenceState(fixture.source);
    let backup = '';
    const result = await fixture.db.resetClinicData({ actor: fixture.reviewer.username, actorRole: 'admin' }, async client => {
      for await (const line of fixture.db.backupSqlLines(client)) backup += line;
      return { ok: true, backupId: 'synthetic-identity-reset' };
    });
    expect(result).toMatchObject({ ok: true, backupId: 'synthetic-identity-reset' });
    const after = await rows(fixture.source);
    for (const table of ['users', 'parties', 'hr_staff', ...identityTables]) expect(after[table], table).toEqual(before[table]);
    expect(await sequenceState(fixture.source)).toEqual(beforeSequences);
    for (const replay of replays) {
      expect(backup).toContain(replay.receipt.runId);
      expect(await applyHrPersonIdentityPlan(fixture.db.getPool(), fixture.reviewer, { requestId: replay.requestId, plan: replay.plan })).toEqual(replay.receipt);
    }
  });

  it('the base runtime can restart with this schema and corrected history without converting identities or changing access', async () => {
    process.env.DATABASE_URL = fixture.source.options.connectionString!;
    process.env.SKIP_SEED = 'false';
    const before = await rows(fixture.source), state = await sequenceState(fixture.source);
    await fixture.db.resetPoolForTesting(); await fixture.db.ensureSchema();
    await fixture.db.resetPoolForTesting(); await fixture.db.ensureSchema();
    expect(await rows(fixture.source)).toEqual(before);
    expect(await sequenceState(fixture.source)).toEqual(state);
    for (const replay of replays) expect(await applyHrPersonIdentityPlan(fixture.db.getPool(), fixture.reviewer, { requestId: replay.requestId, plan: replay.plan })).toEqual(replay.receipt);
  });
});
