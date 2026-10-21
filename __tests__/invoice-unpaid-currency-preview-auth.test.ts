/** Real canonical session checks + findUserByUsername SQL against a mock client.
 * Transaction ordering/control-flow proof only; actual lock proof lives in PG. */
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), ensure: vi.fn(), failRollback: false, failRelease: false,
  user: {} as Record<string, unknown>, lateExpired: false, authReads: 0 }));
vi.mock('../lib/db', async original => ({ ...await original<typeof import('../lib/db')>(),
  ensureSchema: mocks.ensure, getPool: () => ({ connect: async () => ({ query: mocks.query, release: mocks.release }) }),
  getSettingsInTransaction: async () => ({}),
}));
import { sessionCredentialVersion, type SessionPayload } from '../lib/auth';
import { readUnpaidCurrencyCorrection } from '../lib/invoice-unpaid-currency-db';
vi.stubEnv('SESSION_SECRET', 'synthetic-preview-auth-test-secret-only-2026');
const session: SessionPayload = { userId: 7, username: 'admin', role: 'admin', credentialVersion: sessionCredentialVersion('synthetic'), expiresAt: Date.now() + 3600000 };
beforeEach(() => {
  vi.clearAllMocks(); mocks.failRollback = false; mocks.failRelease = false; mocks.lateExpired = false; mocks.authReads = 0;
  session.expiresAt = Date.now() + 3600000;
  mocks.user = { id: 7, username: 'admin', role: 'admin', password_hash: 'synthetic', is_active: true };
  mocks.release.mockImplementation(() => { if (mocks.failRelease) throw Error('release failure'); });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM users')) { mocks.authReads++; if (mocks.lateExpired && mocks.authReads === 2) session.expiresAt = 0; return { rows: [mocks.user] }; }
    if (sql === 'ROLLBACK' && mocks.failRollback) throw Error('rollback failure');
    if (sql.includes('to_jsonb(i)')) return { rows: [{ invoice: { id: 2, patient_id: 1, invoice_number: 'I-2', base_currency: 'YER', total_minor: 100, discount_minor: 0, status: 'open', note: null }, items: [{ id: 3, quantity: 1, unit_price_minor: 100, doctor_id: null }], created_at_exact: '2026-01-01T00:00:00.123456Z' }] };
    if (sql.includes(' AS present')) return { rows: [{ present: false }] };
    if (sql.includes('clock_timestamp()')) return { rows: [{ now: '2026-10-21T00:00:00Z' }] };
    return { rows: [] };
  });
});
it('begins writable snapshot before real canonical FOR SHARE lookup, revalidates before commit, and never initializes schema', async () => {
  expect((await readUnpaidCurrencyCorrection(2, 1, session)).sourceCreatedAt).toBe('2026-01-01T00:00:00.123456Z');
  const sql = mocks.query.mock.calls.map(call => call[0] as string);
  expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
  expect(sql[1]).toContain('FROM users'); expect(sql[1]).toContain('FOR SHARE');
  expect(sql.at(-2)).toContain('FOR SHARE'); expect(sql.at(-1)).toBe('COMMIT');
  expect(mocks.ensure).not.toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalledWith(false);
  expect(sql.some(value => /^(INSERT|UPDATE|DELETE|ALTER|CREATE)/.test(value))).toBe(false);
});
it.each([{ id: 8 }, { password_hash: 'revoked' }, { role: 'doctor' }])('real canonical check rejects changed authority %j before reading source', async change => {
  Object.assign(mocks.user, change);
  await expect(readUnpaidCurrencyCorrection(2, 1, session)).rejects.toThrow(/جلسة/);
  expect(mocks.query.mock.calls.some(call => String(call[0]).includes('to_jsonb(i)'))).toBe(false);
  expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK'); expect(mocks.release).toHaveBeenCalledWith(false);
});
it('late expiration rolls back without returning a preview', async () => {
  mocks.lateExpired = true;
  await expect(readUnpaidCurrencyCorrection(2, 1, session)).rejects.toThrow(/جلسة/);
  expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK');
});
it('destroys the client after rollback failure and still rejects', async () => {
  mocks.user.id = 8; mocks.failRollback = true;
  await expect(readUnpaidCurrencyCorrection(2, 1, session)).rejects.toThrow(/جلسة/);
  expect(mocks.release).toHaveBeenCalledWith(true);
});
it('release failure cannot yield successful preview data', async () => {
  mocks.failRelease = true;
  await expect(readUnpaidCurrencyCorrection(2, 1, session)).rejects.toThrow('release failure');
});
