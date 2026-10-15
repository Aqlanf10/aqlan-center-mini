import { afterAll, beforeAll, expect, it } from 'vitest';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import('../../lib/db'), hr: typeof import('../../lib/hr');
let actor: SessionPayload, stranger: SessionPayload, patientId: number;
let serial = 0;
const saved = { url: process.env.DATABASE_URL, seed: process.env.SKIP_SEED, max: process.env.DB_POOL_MAX };
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = 'false'; process.env.DB_POOL_MAX = '4';
  db = await import('../../lib/db'); hr = await import('../../lib/hr');
  await db.resetPoolForTesting(); await db.ensureSchema();
  const rows = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES ('task-authority-owner','Synthetic owner','synthetic-task-hash','admin'),('task-authority-other','Synthetic other','synthetic-task-hash','admin') RETURNING *")).rows;
  [actor, stranger] = rows.map(row => ({ userId: row.id, username: row.username, role: row.role,
    expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion(row.password_hash) }));
  patientId = (await fixture.source.query("INSERT INTO patients(patient_number,full_name) VALUES ('TASK-AUTH-SYNTHETIC','Synthetic task link') RETURNING id")).rows[0].id;
}, 30000);
afterAll(async () => {
  try { await db?.resetPoolForTesting(); await fixture?.close(); }
  finally { process.env.DATABASE_URL = saved.url; process.env.SKIP_SEED = saved.seed; process.env.DB_POOL_MAX = saved.max; }
});
const operations = ['update', 'comment', 'checklist-add', 'checklist-toggle', 'checklist-remove', 'link-add', 'link-remove'] as const;
type Operation = typeof operations[number];
async function prepare() {
  const result = await hr.createTask({ title: `Synthetic private authority ${++serial}`, description: 'Synthetic private canary',
    isPrivate: true, priority: 'normal', dueAt: null, plannedFor: null, assigneeStaffId: null }, actor);
  if (!result.ok) throw new Error(result.error);
  const taskId = result.value.id;
  const itemId = (await fixture.source.query("INSERT INTO hr_task_checklist(task_id,label,position) VALUES($1,'Synthetic checklist',1) RETURNING id", [taskId])).rows[0].id;
  const linkId = (await fixture.source.query("INSERT INTO hr_task_links(task_id,link_kind,link_id,link_label,linked_by) VALUES($1,'patient',$2,'Synthetic link',$3) RETURNING id", [taskId, patientId, actor.username])).rows[0].id;
  return { taskId, itemId, linkId };
}
function mutate(op: Operation, ids: Awaited<ReturnType<typeof prepare>>, session: SessionPayload) {
  if (op === 'update') return hr.updateTask(ids.taskId, { title: 'Synthetic changed private title' }, session);
  if (op === 'comment') return hr.addTaskComment(ids.taskId, 'Synthetic private comment', session, `authority-comment-${ids.taskId}`);
  if (op === 'checklist-add') return hr.mutateTaskChecklist(ids.taskId, { op: 'add', label: 'Synthetic added item', clientRequestId: `authority-item-${ids.taskId}` }, session);
  if (op === 'checklist-toggle') return hr.mutateTaskChecklist(ids.taskId, { op: 'toggle', itemId: ids.itemId, done: true }, session);
  if (op === 'checklist-remove') return hr.mutateTaskChecklist(ids.taskId, { op: 'remove', itemId: ids.itemId }, session);
  if (op === 'link-add') return hr.addTaskLink(ids.taskId, 'patient', patientId, session);
  return hr.removeTaskLink(ids.taskId, ids.linkId, session);
}
async function state() {
  const result: Record<string, unknown> = {};
  for (const table of ['hr_tasks', 'hr_task_events', 'hr_task_comments', 'hr_task_checklist', 'hr_task_links', 'audit_log', 'expenses', 'payables']) {
    result[table] = (await fixture.source.query(`SELECT to_jsonb(t)::text AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
for (const op of operations) for (const change of ['role', 'credential', 'active', 'expiry'] as const) {
  it(`${op}: refuses ${change} after admission while awaiting the task row, with no domain/event/audit/financial write`, async () => {
    const ids = await prepare();
    // The add-link operation must otherwise be valid, not refused as a duplicate.
    if (op === 'link-add') await fixture.source.query('DELETE FROM hr_task_links WHERE id=$1', [ids.linkId]);
    const before = await state(), session = { ...actor, expiresAt: Date.now() + (change === 'expiry' ? 800 : 3600000) };
    const blocker = await fixture.source.connect(); let pending: ReturnType<typeof mutate> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM hr_tasks WHERE id=$1 FOR UPDATE', [ids.taskId]);
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = mutate(op, ids, session);
      await expect.poll(async () => (await db.getPool().query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked).toBe(true);
      if (change === 'role') await blocker.query("UPDATE users SET role='reception' WHERE id=$1", [actor.userId]);
      else if (change === 'credential') await blocker.query("UPDATE users SET password_hash='synthetic-revoked-hash' WHERE id=$1", [actor.userId]);
      else if (change === 'active') await blocker.query('UPDATE users SET is_active=false WHERE id=$1', [actor.userId]);
      else await new Promise(resolve => setTimeout(resolve, Math.max(0, session.expiresAt - Date.now()) + 20));
      await blocker.query('COMMIT');
      const refused = await pending;
      expect(refused).toMatchObject({ ok: false, status: 401 });
      expect(JSON.stringify(refused)).not.toContain('Synthetic private');
    } finally {
      await blocker.query('ROLLBACK'); blocker.release(); await pending;
      await fixture.source.query("UPDATE users SET role='admin',password_hash='synthetic-task-hash',is_active=true WHERE id=$1", [actor.userId]);
    }
    expect(await state()).toEqual(before);
    expect((await mutate(op, ids, actor)).ok).toBe(true);
  });
}
it('expiry after the task/user locks while awaiting a checklist row rolls back the write and event', async () => {
  const ids = await prepare(), before = await state(), session = { ...actor, expiresAt: Date.now() + 800 };
  const blocker = await fixture.source.connect(); let pending: ReturnType<typeof mutate> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM hr_task_checklist WHERE id=$1 FOR UPDATE', [ids.itemId]);
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending = mutate('checklist-toggle', ids, session);
    await expect.poll(async () => (await db.getPool().query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked).toBe(true);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, session.expiresAt - Date.now()) + 20));
    await blocker.query('COMMIT'); expect(await pending).toMatchObject({ ok: false, status: 401 });
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
  expect(await state()).toEqual(before);
});
it.each(operations)('%s retains uniform private-task refusal for another current administrator', async op => {
  const ids = await prepare(), before = await state();
  expect(await mutate(op, ids, stranger)).toEqual({ ok: false, status: 404, error: 'المهمة غير موجودة أو غير مرئية لك.' });
  expect(await state()).toEqual(before);
});
