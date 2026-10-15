import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { harness } from './_server';
import { openHrJourneyServer } from './_hr-isolated-server';

let h: Awaited<ReturnType<typeof harness>>, owned: Awaited<ReturnType<typeof openHrJourneyServer>>;
let actorId: number, patientId: number, serial = 0;
beforeAll(async () => {
  h = await harness(); owned = await openHrJourneyServer(h);
  actorId = (await owned.db.query("SELECT id FROM users WHERE username='secadmin'")).rows[0].id;
  patientId = (await owned.db.query("INSERT INTO patients(patient_number,full_name) VALUES('TASK-HTTP-AUTH','Synthetic task authority patient') RETURNING id")).rows[0].id;
}, 240000);
afterAll(async () => { await owned?.close(); });
async function request(path: string, method: string, body: unknown, cookie = h.sessions.admin.cookie) {
  const response = await fetch(`${owned.baseUrl}${path}`, { method,
    headers: { cookie, origin: owned.baseUrl, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const operations = ['update', 'comment', 'checklist-add', 'checklist-toggle', 'checklist-remove', 'link-add', 'link-remove', 'create-replay'] as const;
type Operation = typeof operations[number];
async function prepare(op: Operation) {
  const input = { title: `Synthetic private task ${++serial}`, description: 'Synthetic private authority detail',
    isPrivate: true, priority: 'normal', clientRequestId: `task-mutation-http-${serial}` };
  const created = await request('/api/tasks', 'POST', input); expect(created.status).toBe(201);
  const taskId = created.body.id as number;
  const itemId = (await owned.db.query("INSERT INTO hr_task_checklist(task_id,label,position) VALUES($1,'Synthetic existing checklist',1) RETURNING id", [taskId])).rows[0].id;
  const linkId = op === 'link-add' ? 0 : (await owned.db.query("INSERT INTO hr_task_links(task_id,link_kind,link_id,link_label,linked_by) VALUES($1,'patient',$2,'Synthetic existing link','secadmin') RETURNING id", [taskId, patientId])).rows[0].id;
  return { taskId, itemId, linkId, input };
}
function mutate(op: Operation, ids: Awaited<ReturnType<typeof prepare>>, cookie: string) {
  const path = `/api/tasks/${ids.taskId}`;
  if (op === 'update') return request(path, 'PATCH', { title: 'Synthetic changed task' }, cookie);
  if (op === 'comment') return request(`${path}/comments`, 'POST', { body: 'Synthetic comment', clientRequestId: `comment-${ids.taskId}` }, cookie);
  if (op === 'checklist-add') return request(`${path}/checklist`, 'POST', { op: 'add', label: 'Synthetic new item' }, cookie);
  if (op === 'checklist-toggle') return request(`${path}/checklist`, 'POST', { op: 'toggle', itemId: ids.itemId, done: true }, cookie);
  if (op === 'checklist-remove') return request(`${path}/checklist`, 'POST', { op: 'remove', itemId: ids.itemId }, cookie);
  if (op === 'link-add') return request(`${path}/links`, 'POST', { linkKind: 'patient', linkId: patientId }, cookie);
  if (op === 'link-remove') return request(`${path}/links?linkId=${ids.linkId}`, 'DELETE', undefined, cookie);
  return request('/api/tasks', 'POST', ids.input, cookie);
}
async function state() {
  const result: Record<string, unknown> = {};
  for (const table of ['hr_tasks', 'hr_task_events', 'hr_task_comments', 'hr_task_checklist', 'hr_task_links', 'audit_log', 'expenses', 'payables']) {
    result[table] = (await owned.db.query(`SELECT to_jsonb(t)::text AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
function expiringCookie(expiresAt: number) {
  // Re-sign only the owned fixture's synthetic account with the harness's public
  // test secret. The built server still validates a real signature and credential.
  const [name, token] = h.sessions.admin.cookie.split('=');
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  const body = Buffer.from(JSON.stringify({ ...payload, expiresAt })).toString('base64url');
  const signature = createHmac('sha256', 'security-http-test-secret-0123456789abcdef').update(body).digest('base64url');
  return `${name}=${body}.${signature}`;
}
for (const op of operations) for (const change of ['role', 'credential', 'active', 'expiry'] as const) {
  it(`real ${op} refuses ${change} committed while its task lock is awaited`, async () => {
    const ids = await prepare(op), original = (await owned.db.query('SELECT role,password_hash,is_active FROM users WHERE id=$1', [actorId])).rows[0];
    const before = await state(), expiresAt = Date.now() + 1500;
    const cookie = change === 'expiry' ? expiringCookie(expiresAt) : h.sessions.admin.cookie;
    const blocker = await owned.db.connect(); let pending: ReturnType<typeof mutate> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM hr_tasks WHERE id=$1 FOR UPDATE', [ids.taskId]);
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = mutate(op, ids, cookie);
      await expect.poll(async () => (await owned.db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked).toBe(true);
      if (change === 'role') await blocker.query("UPDATE users SET role='reception' WHERE id=$1", [actorId]);
      else if (change === 'credential') await blocker.query("UPDATE users SET password_hash='synthetic-revoked-http' WHERE id=$1", [actorId]);
      else if (change === 'active') await blocker.query('UPDATE users SET is_active=false WHERE id=$1', [actorId]);
      else await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 30));
      await blocker.query('COMMIT');
      const refused = await pending; expect(refused.status).toBe(op === 'create-replay' ? 403 : 401);
      expect(JSON.stringify(refused.body)).not.toContain(ids.input.title);
      expect(JSON.stringify(refused.body)).not.toContain(ids.input.description);
      expect(Object.keys(refused.body).sort()).toEqual(op === 'create-replay' ? ['creationRefusal', 'message'] : ['message']);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release(); await pending;
      await owned.db.query('UPDATE users SET role=$1,password_hash=$2,is_active=$3 WHERE id=$4', [original.role, original.password_hash, original.is_active, actorId]);
    }
    expect(await state()).toEqual(before);
    expect((await mutate(op, ids, h.sessions.admin.cookie)).status).toBe(['comment', 'link-add', 'create-replay'].includes(op) ? 201 : 200);
  });
}
