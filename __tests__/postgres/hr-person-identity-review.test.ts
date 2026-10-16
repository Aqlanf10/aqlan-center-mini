import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DbClient } from '../../lib/db';
import { setStaffUserLink, staffIdForUser } from '../../lib/hr';
import { readPersonIdentitySchema } from '../../lib/hr-person-identity-schema-state';
import { identityDatabaseState } from '../helpers/hr-identity-state';
import { openPersonIdentityReviewFixture } from './_hr-person-review-fixture';

let f: Awaited<ReturnType<typeof openPersonIdentityReviewFixture>>;
beforeAll(async () => { f = await openPersonIdentityReviewFixture(); });
afterAll(async () => { await f?.close(); });
async function person() {
  const a = await f.account(), b = await f.account(), staffId = await f.staff(a.userId);
  const receipt = await f.convert(staffId, [a.userId, b.userId]);
  return { a, b, staffId, receipt };
}
async function rawLink(client: DbClient, p: Awaited<ReturnType<typeof person>>, userId: number) {
  const { rows: [event] } = await client.query(`INSERT INTO hr_identity_events(run_id,staff_id,revision,actor_user_id,action,reason,source_ref,details)
    VALUES($1,$2,1,$3,'link_account','Synthetic concurrent proof','synthetic-review-proof',jsonb_build_object('userId',$4::int)) RETURNING id`,
  [p.receipt.runId, p.staffId, f.reviewer.userId, userId]);
  return client.query('INSERT INTO hr_staff_account_links(staff_id,user_id,opened_event_id) VALUES($1,$2,$3)', [p.staffId, userId, event.id]);
}
it('legacy writer cannot claim the secondary account of a converted person or grant access to another staff record', async () => {
  const p = await person(), legacyId = await f.staff(), before = await identityDatabaseState(f.source);
  try {
    expect(await staffIdForUser(p.b.userId)).toBeNull();
    expect(await setStaffUserLink(legacyId, p.b.userId, 'Synthetic conflicting claim', f.reviewer)).toMatchObject({ ok: false, status: 409 });
    expect(await identityDatabaseState(f.source)).toEqual(before);
    expect(await staffIdForUser(p.b.userId)).toBeNull();
  } finally { await f.source.query('UPDATE hr_staff SET user_id=NULL,user_linked_at=NULL WHERE id=$1', [legacyId]); }
});
it('SQL rejects claims in both directions, including inserting a legacy profile with a converted secondary account', async () => {
  const p = await person(), legacyId = await f.staff(), reserved = await f.account();
  await f.source.query('UPDATE hr_staff SET user_id=$1 WHERE id=$2', [reserved.userId, legacyId]);
  const client = await f.db.getPool().connect();
  try {
    await expect(f.source.query('UPDATE hr_staff SET user_id=$1 WHERE id=$2', [p.b.userId, legacyId])).rejects.toMatchObject({ code: '23505' });
    await expect(f.source.query(`INSERT INTO hr_staff(full_name,user_id,created_by,work_status,contract_kind)
      VALUES('Synthetic conflicting insert',$1,'synthetic','active','commission')`, [p.b.userId])).rejects.toMatchObject({ code: '23505' });
    await client.query('BEGIN');
    await expect(rawLink(client, p, reserved.userId)).rejects.toThrow(/reserved legacy/);
  } finally { await client.query('ROLLBACK'); client.release(); await f.source.query('UPDATE hr_staff SET user_id=NULL,user_linked_at=NULL WHERE id=$1', [legacyId]); }
});
for (const first of ['legacy', 'identity'] as const) it(`concurrent SQL claims serialize when ${first} wins first`, async () => {
  const p = await person(), legacyId = await f.staff(), account = await f.account();
  const winner = await f.db.getPool().connect(), loser = await f.db.getPool().connect();
  let result: Promise<unknown> | undefined;
  try {
    await winner.query('BEGIN'); await loser.query('BEGIN');
    const legacyClaim = (client: DbClient) => client.query('UPDATE hr_staff SET user_id=$1 WHERE id=$2', [account.userId, legacyId]);
    if (first === 'legacy') await legacyClaim(winner); else await rawLink(winner, p, account.userId);
    const pid = (await winner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    result = (first === 'legacy' ? rawLink(loser, p, account.userId) : legacyClaim(loser)).then(() => ({ ok: true }), error => ({ ok: false, error }));
    let blocked = false;
    for (let i = 0; i < 200; i++) {
      blocked = (await f.source.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked;
      if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true); await winner.query('COMMIT');
    expect(await result).toMatchObject({ ok: false, error: { code: '23505' } });
    await loser.query('ROLLBACK');
    expect((await f.source.query('SELECT user_id FROM hr_staff WHERE id=$1', [legacyId])).rows[0].user_id).toBe(first === 'legacy' ? account.userId : null);
    expect((await f.source.query('SELECT staff_id FROM hr_staff_account_links WHERE user_id=$1 AND closed_at IS NULL', [account.userId])).rows).toEqual(first === 'identity' ? [{ staff_id: p.staffId }] : []);
  } finally {
    await winner.query('ROLLBACK'); await loser.query('ROLLBACK'); winner.release(); loser.release(); await result;
    await f.source.query('UPDATE hr_staff SET user_id=NULL,user_linked_at=NULL WHERE id=$1', [legacyId]);
  }
});
for (const direction of ['legacy', 'identity'] as const) it(`${direction} account claim refuses a repeatable snapshot instead of checking stale cross-table state`, async () => {
  const p = await person(), legacyId = await f.staff(), account = await f.account();
  const client = await f.db.getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const claim = direction === 'legacy'
      ? client.query('UPDATE hr_staff SET user_id=$1 WHERE id=$2', [account.userId, legacyId])
      : rawLink(client, p, account.userId);
    await expect(claim).rejects.toMatchObject({ code: '40001' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});
const mutations = [
  ['wrong index key', 'DROP INDEX hr_staff_account_links_current_user; CREATE UNIQUE INDEX hr_staff_account_links_current_user ON hr_staff_account_links(id) WHERE closed_at IS NULL'],
  ['wrong index predicate', 'DROP INDEX hr_staff_account_links_current_user; CREATE UNIQUE INDEX hr_staff_account_links_current_user ON hr_staff_account_links(user_id) WHERE closed_at IS NOT NULL'],
  ['wrong trigger events', 'DROP TRIGGER hr_account_link_history ON hr_staff_account_links; CREATE TRIGGER hr_account_link_history BEFORE UPDATE ON hr_staff_account_links FOR EACH ROW EXECUTE FUNCTION aqlan_hr_identity_link_history()'],
  ['wrong trigger body', "CREATE OR REPLACE FUNCTION aqlan_hr_identity_link_history() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql"],
  ['missing FK', 'ALTER TABLE hr_staff_account_links DROP CONSTRAINT hr_staff_account_links_user_id_fkey'],
  ['missing CHECK', 'ALTER TABLE hr_staff DROP CONSTRAINT hr_staff_pay_terms_complete'],
  ['wrong column default', 'ALTER TABLE hr_staff ALTER COLUMN identity_revision SET DEFAULT 1'],
  ['partial removal with functions left behind', `DROP TABLE hr_staff_account_links,hr_staff_party_links,hr_identity_events,hr_identity_import_runs CASCADE;
    ALTER TABLE hr_staff DROP COLUMN identity_revision CASCADE;
    ALTER TABLE hr_leave_requests DROP COLUMN requester_user_id,DROP COLUMN identity_evidence;
    ALTER TABLE hr_attendance_corrections DROP COLUMN requester_user_id,DROP COLUMN identity_evidence`],
] as const;
for (const [label, sql] of mutations) it(`refuses ${label} instead of blessing its fingerprint`, async () => {
  const client = await f.db.getPool().connect();
  try {
    await client.query('BEGIN'); await client.query(sql);
    const before = await identityDatabaseState(client);
    await expect(readPersonIdentitySchema(client)).rejects.toMatchObject({ status: 503 });
    expect(await identityDatabaseState(client)).toEqual(before);
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect(await readPersonIdentitySchema(f.source)).toMatch(/^[a-f0-9]{64}$/);
});
