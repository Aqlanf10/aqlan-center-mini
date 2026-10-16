import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import('../../lib/db'), hr: typeof import('../../lib/hr'), pay: typeof import('../../lib/hr-payroll');
let actor: SessionPayload, reviewer: SessionPayload;
const saved = { url: process.env.DATABASE_URL, seed: process.env.SKIP_SEED, max: process.env.DB_POOL_MAX };
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = 'false'; process.env.DB_POOL_MAX = '4';
  db = await import('../../lib/db'); hr = await import('../../lib/hr'); pay = await import('../../lib/hr-payroll');
  await db.resetPoolForTesting(); await db.ensureSchema();
  const rows = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES ('expense-race-owner','Synthetic owner','synthetic-expense-hash','admin'),('expense-race-reviewer','Synthetic reviewer','synthetic-expense-hash','admin') RETURNING *")).rows;
  [actor, reviewer] = rows.map(row => ({ userId: row.id, username: row.username, role: row.role,
    expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion(row.password_hash) }));
}, 30000);
afterAll(async () => {
  try { await db?.resetPoolForTesting(); await fixture?.close(); }
  finally { process.env.DATABASE_URL = saved.url; process.env.SKIP_SEED = saved.seed; process.env.DB_POOL_MAX = saved.max; }
});
async function state() {
  const result: Record<string, unknown> = {};
  for (const table of ['expenses', 'payables', 'hr_payroll_runs', 'hr_payroll_items', 'hr_payroll_disbursements', 'hr_payroll_disbursement_parts', 'audit_log']) {
    result[table] = (await fixture.source.query(`SELECT to_jsonb(t)::text AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
it.each(['early-lookup', 'absent-locked-voucher'] as const)('refuses a general reversal when a real payroll payout commits after %s', async boundary => {
  const staff = await hr.createStaff({ fullName: 'Synthetic expense race staff', department: 'secretariat', jobTitle: 'Synthetic',
    hireDate: '2026-01-01', endDate: null, workStatus: 'active', contractKind: 'salary', phone: null, note: null,
    payTerms: { amountMinor: 1000, currency: 'YER', period: 'monthly', effectiveOn: '2026-01-01' } }, actor);
  const period = await pay.getOrCreatePayrollPeriod(boundary === 'early-lookup' ? '2026-08' : '2026-09', actor);
  const run = await pay.calculatePayrollRun(period.id, 'YER', actor);
  await pay.approvePayrollRun(run.id, reviewer);
  const item = (await pay.listPayrollItems(run.id)).find(row => row.staffId === staff.id)!;
  expect(item.netDueMinor).toBe(1000);
  await db.openShift({ openedBy: actor.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  // This owned fixture has no competing expense writer. Discover the next ID without
  // changing the sequence; the normal payroll transaction must allocate it itself.
  const sequence = (await fixture.source.query('SELECT last_value::int, is_called FROM expenses_id_seq')).rows[0];
  const expenseId = sequence.last_value + (sequence.is_called ? 1 : 0);
  const client = await db.getPool().connect(), originalQuery = client.query;
  let releaseRead!: () => void, observedRead!: () => void;
  const gate = new Promise<void>(resolve => { releaseRead = resolve; });
  const observed = new Promise<void>(resolve => { observedRead = resolve; });
  let paused = false;
  const query = vi.spyOn(client, 'query').mockImplementation((async (...args: unknown[]) => {
    const result = await Reflect.apply(originalQuery, client, args);
    const pauseHere = boundary === 'early-lookup'
      ? typeof args[0] === 'string' && args[0].startsWith('SELECT 1 FROM hr_payroll_disbursement_parts')
      : args[0] === 'SELECT id FROM expenses WHERE id=$1 FOR UPDATE';
    if (!paused && pauseHere) {
      paused = true;
      expect(result.rows).toHaveLength(0);
      observedRead(); await gate;
    }
    return result;
  }) as typeof client.query);
  // All SQL and commits remain real PostgreSQL; only the boundary after the first
  // completed lookup is paused. The other payout receives an ordinary pool client.
  const connect = vi.spyOn(db.getPool(), 'connect').mockResolvedValueOnce(client);
  let pending: Promise<{ result?: unknown; error?: unknown }> | undefined;
  try {
    pending = db.voidExpense(expenseId, { actor: actor.username, actorRole: actor.role, reason: 'Synthetic general reversal' })
      .then(result => ({ result }), error => ({ error }));
    await observed;
    const payout = await pay.disbursePayrollItem(item.id, { amountMinor: 1000, paymentMethod: 'cash', clientRequestId: `synthetic-expense-race-${boundary}` }, actor);
    expect(payout.expenseId).toBe(expenseId);
    const committed = await state();
    releaseRead();
    expect(await pending).toMatchObject(boundary === 'early-lookup'
      ? { error: expect.objectContaining({ message: expect.stringContaining('وحدة الموظفين') }) }
      : { result: { ok: false, reason: 'not_found' } });
    expect(await state()).toEqual(committed);
    // The canonical HR reversal still atomically corrects both the voucher and totals.
    await pay.reversePayrollDisbursement(payout.id, { reason: 'Synthetic authorized HR reversal' }, actor);
    expect((await pay.listPayrollItems(run.id)).find(row => row.id === item.id)).toMatchObject({ paidMinor: 0, remainingMinor: 1000 });
    expect((await fixture.source.query('SELECT amount_minor::text FROM expenses WHERE reversal_of_id=$1', [expenseId])).rows).toEqual([{ amount_minor: '-1000' }]);
  } finally { releaseRead(); await pending; query.mockRestore(); connect.mockRestore(); }
});
