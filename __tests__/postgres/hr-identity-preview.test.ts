import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { readHrIdentityPreview } from '../../lib/hr-identity-read';
import { identityDatabaseState } from '../helpers/hr-identity-state';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>, db: typeof import('../../lib/db');
let admin: SessionPayload, doctorId: number, partyId: number, otherPartyId: number, staffId: number;
const saved = { url: process.env.DATABASE_URL, seed: process.env.SKIP_SEED, secret: process.env.SESSION_SECRET };
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = 'false'; process.env.SESSION_SECRET = 'synthetic-identity-preview-secret-0123456789';
  db = await import('../../lib/db'); await db.resetPoolForTesting(); await db.ensureSchema();
  const parties = (await fixture.source.query("INSERT INTO parties(name,kind) VALUES ('Identity doctor','doctor'),('Identity no account','doctor'),('Excluded supplier','supplier') RETURNING id")).rows;
  partyId = parties[0].id; otherPartyId = parties[1].id;
  const accounts = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role,party_id,commission_config) VALUES ('identityadmin','Identical display','synthetic-hash','admin',NULL,NULL),('identitydoctor','Identical display','synthetic-hash','doctor',$1,'{\"defaultPercent\":40}'),('identityreception','Reception','synthetic-hash','reception',NULL,NULL),('identityunlinked','Unlinked doctor','synthetic-hash','doctor',NULL,NULL) RETURNING id", [partyId])).rows;
  doctorId = accounts[1].id;
  admin = { userId: accounts[0].id, username: 'identityadmin', role: 'admin', expiresAt: Date.now()+60_000, credentialVersion: sessionCredentialVersion('synthetic-hash') };
  staffId = (await fixture.source.query("INSERT INTO hr_staff(full_name,user_id,created_by) VALUES ('Incomplete HR',$1,'synthetic') RETURNING id", [accounts[2].id])).rows[0].id;
});
afterAll(async () => {
  try { await db?.resetPoolForTesting(); await fixture?.close(); }
  finally { process.env.DATABASE_URL=saved.url; process.env.SKIP_SEED=saved.seed; process.env.SESSION_SECRET=saved.secret; }
});
it('all preview queries run under PostgreSQL READ ONLY and neither rows nor sequences change, including an unlinked doctor', async () => {
  const before = await identityDatabaseState(fixture.source), modes: string[] = [], commands: string[] = [];
  const pool = { connect: async () => {
    const client = await fixture.source.connect();
    return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
      commands.push(sql);
      if (/^SELECT/i.test(sql)) modes.push((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only);
      return client.query(sql, values);
    } };
  } } as unknown as Pool;
  const baseline = await readHrIdentityPreview(pool, admin);
  const reviewed = await readHrIdentityPreview(pool, admin, { sourceDigest: baseline.sourceDigest, decisions: [{ userIds: [admin.userId,doctorId], partyIds: [partyId], staffId: null, confirmedSamePerson: true }] });
  expect(reviewed.candidates[0]).toMatchObject({ action: 'create', userIds: [admin.userId,doctorId], partyIds: [partyId] });
  expect(baseline.candidates.find(c => c.key === `staff:${staffId}`)?.unknowns).toContain('missing_hire_date');
  expect(baseline.candidates.find(c => c.key === `party:${otherPartyId}`)?.action).toBe('skip');
  expect(new Set(modes)).toEqual(new Set(['on']));
  expect(commands.every(sql => /^(SELECT|BEGIN TRANSACTION|COMMIT)/.test(sql))).toBe(true);
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
  const result = JSON.stringify(reviewed);
  for (const forbidden of ['password_hash','synthetic-hash','credentialVersion','commission_config','defaultPercent','salary_amount_minor','permissions','session']) expect(result).not.toContain(forbidden);
});
it('stale sources return409 without applying or allocating anything', async () => {
  const baseline = await readHrIdentityPreview(fixture.source, admin);
  await fixture.source.query('UPDATE users SET is_active=FALSE WHERE id=$1',[doctorId]);
  const before = await identityDatabaseState(fixture.source);
  try {
    await expect(readHrIdentityPreview(fixture.source, admin, { sourceDigest: baseline.sourceDigest, decisions: [] })).rejects.toMatchObject({ status: 409 });
    expect(await identityDatabaseState(fixture.source)).toEqual(before);
  } finally { await fixture.source.query('UPDATE users SET is_active=TRUE WHERE id=$1',[doctorId]); }
});
it('expired, revoked, inactive or changed-role authority cannot read the roster', async () => {
  await expect(readHrIdentityPreview(fixture.source, { ...admin, expiresAt: 1 })).rejects.toMatchObject({ status: 401 });
  await expect(readHrIdentityPreview(fixture.source, { ...admin, credentialVersion: 'revoked' })).rejects.toMatchObject({ status: 401 });
  await fixture.source.query('UPDATE users SET is_active=FALSE WHERE id=$1',[admin.userId]);
  try { await expect(readHrIdentityPreview(fixture.source, admin)).rejects.toMatchObject({ status: 401 }); }
  finally { await fixture.source.query('UPDATE users SET is_active=TRUE WHERE id=$1',[admin.userId]); }
  await fixture.source.query("UPDATE users SET role='reception' WHERE id=$1",[admin.userId]);
  try {
    await expect(readHrIdentityPreview(fixture.source, admin)).rejects.toMatchObject({ status: 401 });
    await expect(readHrIdentityPreview(fixture.source, { ...admin, role: 'reception' })).rejects.toMatchObject({ status: 403 });
  } finally { await fixture.source.query("UPDATE users SET role='admin' WHERE id=$1",[admin.userId]); }
});
it('contradictory contract and account references surface as conflict, preserving the source rows', async () => {
  await fixture.source.query("INSERT INTO hr_contracts(staff_id,contract_number,template_kind,title,status,start_date,compensation_kind,doctor_party_id,created_by) VALUES($1,'IDENTITY-CONFLICT','support_staff','Synthetic conflict','approved','2026-01-01','commission',$2,'synthetic')",[staffId,otherPartyId]);
  const before = await identityDatabaseState(fixture.source), baseline = await readHrIdentityPreview(fixture.source, admin);
  const reviewed = await readHrIdentityPreview(fixture.source,admin,{sourceDigest:baseline.sourceDigest,decisions:[{userIds:[doctorId],partyIds:[partyId],staffId,confirmedSamePerson:true}]});
  expect(reviewed.candidates[0].action).toBe('conflict');
  expect(reviewed.candidates[0].reasons).toContain('different_parties');
  expect(await identityDatabaseState(fixture.source)).toEqual(before);
});
it('missing schema fails closed and is never bootstrapped or repaired by the preview', async () => {
  await fixture.source.query('ALTER TABLE hr_contracts RENAME TO identity_test_hidden_contracts');
  const before = await identityDatabaseState(fixture.source);
  try {
    await expect(readHrIdentityPreview(fixture.source, admin)).rejects.toMatchObject({ code: '42P01' });
    expect(await identityDatabaseState(fixture.source)).toEqual(before);
  } finally { await fixture.source.query('ALTER TABLE identity_test_hidden_contracts RENAME TO hr_contracts'); }
});
