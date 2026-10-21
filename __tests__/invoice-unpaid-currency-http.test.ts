import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('../lib/session', () => ({ requireSession: mocks.session }));
vi.mock('../lib/invoice-unpaid-currency-db', () => ({ readUnpaidCurrencyCorrection: mocks.read, correctUnpaidInvoiceCurrency: mocks.write }));
import { debtRequestHash } from '../lib/debt-source-proof';
import { DebtRepaymentError } from '../lib/debt-installments-db';
import { evaluateWrongCurrencyAmounts } from '../lib/invoice-currency-intent';
import { unpaidCurrencyHttp } from '../lib/invoice-unpaid-currency-http';
const path = { invoiceId: '2', patientId: '1' };
const body = { version: 1, kind: 'invoice-currency-correction', evidenceKind: 'unpaid_root_v1', invoiceId: 2, patientId: 1, idempotencyKey: 'request-123', expectedSourceHash: 'a'.repeat(64), discountReason: '', intent: { version: 1, purpose: 'wrong-currency', fromCurrency: 'YER', toCurrency: 'SAR', reason: 'wrong currency', mode: 'preserve-numerals' } };
function post(value: unknown = body, origin: string | null = 'https://clinic.example') {
  return new Request('https://clinic.example/candidate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Unpaid-Currency-Request-Hash': debtRequestHash({ purpose: 'invoice-unpaid-currency-command-v1', request: value, actor: { userId: 7, username: 'admin', role: 'admin' } }), ...(origin ? { origin } : {}) }, body: JSON.stringify(value) });
}
const source = { patientId: 1, invoiceId: 2, sourceHash: 'a'.repeat(64), currency: 'YER', totalMinor: 100, discountMinor: 0, lines: [{ itemId: 3, quantity: 1, unitPriceMinor: 100 }] };
const sourceCreatedAt = '2026-01-01T01:02:03.123456Z';
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue({ ...source, evidenceKind: 'unpaid_root_v1', sourceCreatedAt }); mocks.write.mockResolvedValue({ acknowledgement: { exact: 'writer-owned' }, replayed: false }); vi.stubEnv('APP_ORIGIN', 'https://clinic.example'); mocks.session.mockResolvedValue({ userId: 7, username: 'admin', role: 'admin' }); });
it('calls the reader with the canonical actor and strips envelope metadata from strict amount source', async () => {
  const response = await unpaidCurrencyHttp(new Request('https://clinic.example/candidate'), path);
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
  const preview = await response.json();
  expect(preview).toEqual({ actor: { userId: 7, username: 'admin', role: 'admin' }, source, sourceCreatedAt });
  expect(mocks.read).toHaveBeenCalledWith(2, 1, await mocks.session());
  expect(evaluateWrongCurrencyAmounts(preview.source, body.intent).targetNetMinor).toBe(10000);
  expect(mocks.write).not.toHaveBeenCalled();
});
it.each([false, true])('calls the writer and returns exact acknowledgement/replayed=%s', async replayed => {
  const result = { acknowledgement: { exact: 'writer-owned' }, replayed };
  mocks.write.mockResolvedValue(result);
  const response = await unpaidCurrencyHttp(post(), path);
  expect(response.status).toBe(200); expect(await response.json()).toEqual(result);
  expect(mocks.write).toHaveBeenCalledWith(body, await mocks.session());
  expect(mocks.read).not.toHaveBeenCalled();
});
it.each([['invalid', 400], ['missing', 404], ['unauthorized', 403], ['stale', 409], ['conflict', 409]] as const)('preserves known %s without asserting earlier noncommit', async (code, status) => {
  mocks.write.mockRejectedValue(new DebtRepaymentError(code, 'private detail'));
  const response = await unpaidCurrencyHttp(post(), path);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ code, outcome: 'unconfirmed', recovery: 'retain_exact_command' });
});
it('keeps unknown COMMIT outcome distinct and does not leak exception details', async () => {
  mocks.write.mockRejectedValue(Error('connection lost after COMMIT; sensitive details'));
  const response = await unpaidCurrencyHttp(post(), path);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ code: 'unconfirmed', outcome: 'unconfirmed', recovery: 'retain_exact_command' });
});
it('refuses a different valid current actor before invoking writer', async () => {
  mocks.session.mockResolvedValue({ userId: 8, username: 'other-admin', role: 'admin' });
  const response = await unpaidCurrencyHttp(post(), path);
  expect(response.status).toBe(409); expect((await response.json()).code).toBe('actor_binding_mismatch');
  expect(mocks.write).not.toHaveBeenCalled();
});
it.each([null, 'invalid', 'A'.repeat(64)])('requires frozen actor binding header %s', async hash => {
  const request = post();
  if (hash === null) request.headers.delete('x-unpaid-currency-request-hash');
  else request.headers.set('x-unpaid-currency-request-hash', hash);
  expect((await unpaidCurrencyHttp(request, path)).status).toBe(400);
  expect(mocks.write).not.toHaveBeenCalled();
});
it('rejects lossy preview timestamp', async () => {
  mocks.read.mockResolvedValue({ ...source, sourceCreatedAt: '2026-01-01T01:02:03.123Z' });
  expect((await unpaidCurrencyHttp(new Request('https://clinic.example/candidate'), path)).status).toBe(500);
});
it('preserves bounded-body and malformed-body statuses without dispatch', async () => {
  for (const [raw, status] of [['{', 400], ['x'.repeat(2_000_000), 413]] as const) {
    const response = await unpaidCurrencyHttp(new Request('https://clinic.example/candidate', { method: 'POST', headers: { origin: 'https://clinic.example' }, body: raw }), path);
    expect(response.status).toBe(status); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json()).recovery).toBe('retain_exact_command');
  }
  expect(mocks.write).not.toHaveBeenCalled();
});
it.each(['doctor', 'assistant', 'reception', 'accountant', 'cashier'])('does not expand role %s', async role => {
  mocks.session.mockResolvedValue({ role }); expect((await unpaidCurrencyHttp(post(), path)).status).toBe(403);
});
it('requires current session on every attempt', async () => {
  expect((await unpaidCurrencyHttp(post(), path)).status).toBe(200);
  mocks.session.mockResolvedValue(null); expect((await unpaidCurrencyHttp(post(), path)).status).toBe(401);
});
it.each([null, 'http://clinic.example', 'https://clinic.example:444', 'https://evil.example'])('refuses origin %s', async origin => {
  expect((await unpaidCurrencyHttp(post(body, origin), path)).status).toBe(403);
});
it.each([{ ...body, patientId: 9 }, { ...body, invoiceId: 9 }, { ...body, ready: true }, { ...body, kind: 'invoice-correction' }])('refuses body mismatch/legacy/client authority', async value => {
  expect((await unpaidCurrencyHttp(post(value), path)).status).toBe(400);
});
it.each(['0', '1e0', '01', '-1', '9007199254740992'])('refuses ambiguous path %s', async patientId => {
  expect((await unpaidCurrencyHttp(post(), { ...path, patientId })).status).toBe(400);
});
