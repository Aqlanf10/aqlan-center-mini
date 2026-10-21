import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { debtRequestHash } from '../lib/debt-source-proof';
import type { FinancialCommand } from '../lib/financial-command-journal';
const storage = vi.hoisted(() => ({ revision: 0, command: null as FinancialCommand | null, reserved: false, acknowledgements: 0 }));
vi.mock('../lib/financial-command-journal', async original => ({
  ...await original<typeof import('../lib/financial-command-journal')>(),
  readFinancialJournal: async () => ({ revision: storage.revision, command: storage.command }),
  reserveFinancialCommand: async (_scope: unknown, revision: number, command: FinancialCommand) => {
    if (revision !== storage.revision) throw Error('stale revision');
    if (!storage.command) storage.command = structuredClone(command);
    storage.reserved = true;
    return { revision: storage.revision, command: storage.command };
  },
  acknowledgeFinancialCommand: async () => { storage.command = null; storage.revision++; storage.acknowledgements++; },
}));
import { attemptUnpaidCurrencyCommand, freezeUnpaidCurrencyCommand, restoreUnpaidCurrencyCommand, unpaidCurrencyRequestHash, readUnpaidCurrencyRecovery } from '../lib/invoice-unpaid-currency-recovery';
import { unpaidCurrencyTransport } from '../lib/invoice-unpaid-currency-client';
import type { Currency } from '../lib/money';
const actor = { userId: 7, username: 'admin', role: 'admin' as const };
const source = { patientId: 1, invoiceId: 2, sourceHash: 'a'.repeat(64), currency: 'YER' as Currency, totalMinor: 100, discountMinor: 0, lines: [{ itemId: 3, quantity: 1, unitPriceMinor: 100 }] };
const preview = { actor, source, sourceCreatedAt: '2026-01-01T00:00:00.123456Z' };
function request(from: Currency = 'YER', to: Currency = 'SAR', mode: 'preserve-numerals' | 'reviewed-target-amounts' = 'preserve-numerals') {
  return { version: 1, kind: 'invoice-currency-correction', evidenceKind: 'unpaid_root_v1', invoiceId: 2, patientId: 1, idempotencyKey: 'correction-123', expectedSourceHash: source.sourceHash, discountReason: '', intent: {
    version: 1, purpose: 'wrong-currency', fromCurrency: from, toCurrency: to, reason: 'wrong currency', mode,
    ...(mode === 'reviewed-target-amounts' ? { lines: [{ itemId: 3, unitPrice: '100' }], discount: '0' } : {}),
  } };
}
async function ack(command: FinancialCommand) {
  const { request: r, amounts, evidence } = await restoreUnpaidCurrencyCommand(command, 1, actor);
  return { replayed: true, acknowledgement: { version: 1, kind: r.kind, evidenceKind: r.evidenceKind, correctionId: 8, patientId: 1,
    currency: r.intent.toCurrency, originalCurrency: r.intent.fromCurrency, idempotencyKey: r.idempotencyKey, requestHash: evidence.requestHash,
    createdBy: actor.username, actorUserId: actor.userId, effectiveAt: '2026-02-01T00:00:00.654321Z', amountMode: r.intent.mode,
    settledMinor: 0, sourcePrincipalMinor: amounts.sourceNetMinor, targetPrincipalMinor: amounts.targetNetMinor,
    original: { id: 2, patientId: 1, baseCurrency: r.intent.fromCurrency, invoiceNumber: 'I-2', createdAt: preview.sourceCreatedAt },
    corrected: { id: 9, patientId: 1, baseCurrency: r.intent.toCurrency, invoiceNumber: 'I-9', createdAt: '2026-02-01T00:00:00.654321Z' },
  } };
}
const attempt = (command: FinancialCommand, send: (body: string) => Promise<unknown>, authenticate = async () => actor) => attemptUnpaidCurrencyCommand({ command, patientId: 1, actor, revision: 0, send, authenticate });
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); storage.command = null; storage.revision = 0; storage.reserved = false; storage.acknowledgements = 0; });
describe('isolated U0 frozen recovery, mocked journal boundary, not browser proof', () => {
  for (const from of ['YER', 'SAR', 'USD'] as Currency[]) for (const to of ['YER', 'SAR', 'USD'] as Currency[]) if (from !== to) {
    it.each(['preserve-numerals', 'reviewed-target-amounts'] as const)(`${from} to ${to} %s freezes and verifies exact server acknowledgement`, async mode => {
      const command = await freezeUnpaidCurrencyCommand(request(from, to, mode), { ...preview, source: { ...source, currency: from } });
      const restored = await restoreUnpaidCurrencyCommand(command, 1, actor);
      expect(await unpaidCurrencyRequestHash(restored.request, actor)).toBe(debtRequestHash({ purpose: 'invoice-unpaid-currency-command-v1', request: restored.request, actor }));
      const send = vi.fn(async (body: string) => { expect(storage.reserved).toBe(true); expect(body).toBe(restored.evidence.body); return ack(command); });
      expect(await attempt(command, send)).toEqual({ state: 'acknowledged' });
      expect(storage.command).toBeNull(); expect(storage.acknowledgements).toBe(1);
    });
  }
  it('retains exact bytes after uncertain commit and reload, then replays same key', async () => {
    const command = await freezeUnpaidCurrencyCommand(request(), preview);
    expect((await attempt(command, async () => { throw Error('connection lost after commit'); })).state).toBe('unresolved');
    expect(storage.command).toEqual(command);
    const restored = await readUnpaidCurrencyRecovery(1, actor);
    expect(restored.recovery!.evidence.body).toBe(JSON.parse(command.original).body);
    expect((await attempt(restored.journal.command!, async () => ack(command))).state).toBe('acknowledged');
  });
  it.each(['requestHash', 'actorUserId', 'targetPrincipalMinor', 'sourcePrincipalMinor', 'timestamp', 'malformed'])("retains command for %s mismatch", async field => {
    const command = await freezeUnpaidCurrencyCommand(request(), preview);
    const response = await ack(command);
    if (field === 'timestamp') response.acknowledgement.original.createdAt = '2026-01-01T00:00:00.123457Z';
    else if (field !== 'malformed') (response.acknowledgement as Record<string, unknown>)[field] = field === 'requestHash' ? 'b'.repeat(64) : 777;
    expect((await attempt(command, async () => field === 'malformed' ? {} : response)).state).toBe('unresolved');
    expect(storage.command).toEqual(command); expect(storage.acknowledgements).toBe(0);
  });
  it('never upgrades old command or sends over an occupied shared slot', async () => {
    const command = await freezeUnpaidCurrencyCommand(request(), preview);
    storage.command = { kind: 'invoice-correction', key: 'old-key-123', original: '{"v":1}', payload: '{"v":1}' };
    const original = structuredClone(storage.command), send = vi.fn();
    expect((await readUnpaidCurrencyRecovery(1, actor)).recovery).toBeNull();
    expect(await attempt(command, send)).toEqual({ state: 'unresolved', reason: 'conflict' });
    expect(storage.command).toEqual(original); expect(send).not.toHaveBeenCalled();
  });
  it('competing tab loses without sending; stale revision after completion stays blocked', async () => {
    const first = await freezeUnpaidCurrencyCommand(request(), preview);
    const second = await freezeUnpaidCurrencyCommand({ ...request(), idempotencyKey: 'other-tab-123' }, preview);
    await attempt(first, async () => { throw Error('offline'); });
    const send = vi.fn(); expect((await attempt(second, send)).state).toBe('unresolved'); expect(send).not.toHaveBeenCalled();
    await attempt(first, async () => ack(first));
    expect((await attempt(second, send)).state).toBe('unresolved'); expect(send).not.toHaveBeenCalled();
  });
  it('rejects patient, actor, source hash, changed bytes, and legacy kind on restoration', async () => {
    const command = await freezeUnpaidCurrencyCommand(request(), preview);
    await expect(restoreUnpaidCurrencyCommand(command, 2, actor)).rejects.toThrow();
    await expect(restoreUnpaidCurrencyCommand(command, 1, { ...actor, userId: 8 })).rejects.toThrow();
    await expect(restoreUnpaidCurrencyCommand({ ...command, payload: '{}' }, 1, actor)).rejects.toThrow();
    await expect(restoreUnpaidCurrencyCommand({ ...command, kind: 'invoice-correction' }, 1, actor)).rejects.toThrow();
    await expect(freezeUnpaidCurrencyCommand({ ...request(), expectedSourceHash: 'b'.repeat(64) }, preview)).rejects.toThrow();
  });
  it('revalidates session before send and before retirement', async () => {
    const command = await freezeUnpaidCurrencyCommand(request(), preview), send = vi.fn(async () => ack(command));
    const authenticate = vi.fn().mockResolvedValueOnce(actor).mockResolvedValueOnce({ ...actor, userId: 8 });
    expect(await attempt(command, send, authenticate)).toEqual({ state: 'unresolved', reason: 'session' }); expect(send).not.toHaveBeenCalled(); expect(storage.command).toEqual(command);
    const revoked = vi.fn().mockResolvedValueOnce(actor).mockResolvedValueOnce(actor).mockResolvedValueOnce(null);
    expect((await attempt(command, send, revoked)).state).toBe('unresolved'); expect(storage.command).toEqual(command);
  });
});

describe('unmounted transport wiring using the existing journal/freezer/attempt', () => {
  it.each(['https://elsewhere.example/path', '//elsewhere.example/path', '/\\elsewhere.example/path'])('refuses nonlocal endpoint %s', endpoint => {
    expect(() => unpaidCurrencyTransport({ endpoint, authenticate: async () => actor, fetch })).toThrow();
  });
  it('reads the exact envelope and sends reserved frozen bytes with canonical actor checks', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('same-origin'); expect(init?.cache).toBe('no-store');
      expect(init?.mode).toBe('same-origin'); expect(init?.redirect).toBe('error');
      if (init?.method === 'GET') return Response.json(preview);
      expect(storage.reserved).toBe(true);
      expect(init?.body).toBe(JSON.parse(command.original).body);
      expect(new Headers(init?.headers).get('x-unpaid-currency-request-hash')).toBe(JSON.parse(command.original).requestHash);
      return Response.json(await ack(command));
    });
    const transport = unpaidCurrencyTransport({ endpoint: '/unmounted-test-only', authenticate: async () => actor, fetch: fetcher });
    const command = await transport.prepare(request(), await transport.preview());
    expect(await transport.attempt(command, 1, actor, 0)).toEqual({ state: 'acknowledged' });
    expect(storage.command).toBeNull();
  });
  it('retains the exact reserved command when fetch refuses a redirect', async () => {
    const command = await freezeUnpaidCurrencyCommand(request(), preview);
    const transport = unpaidCurrencyTransport({ endpoint: '/unmounted-test-only', authenticate: async () => actor,
      fetch: async (_url, init) => {
        expect(init?.mode).toBe('same-origin'); expect(init?.redirect).toBe('error');
        throw new TypeError('fetch rejected redirect');
      } });
    expect(await transport.attempt(command, 1, actor, 0)).toEqual({ state: 'unresolved', reason: 'unconfirmed' });
    expect(storage.command).toEqual(command); expect(storage.acknowledgements).toBe(0);
  });
  it.each([400, 401, 403, 404, 409, 500])('preserves durable command after HTTP %s', async status => {
    const command = await freezeUnpaidCurrencyCommand(request(), preview);
    const transport = unpaidCurrencyTransport({ endpoint: '/unmounted-test-only', authenticate: async () => actor,
      fetch: async () => Response.json({ outcome: 'unconfirmed' }, { status }) });
    expect((await transport.attempt(command, 1, actor, 0)).state).toBe('unresolved');
    expect(storage.command).toEqual(command); expect(storage.acknowledgements).toBe(0);
  });
  it.each([{ ...preview, ready: true }, { ...preview, source: { ...source, evidenceKind: 'unpaid_root_v1' } },
    { ...preview, sourceCreatedAt: '2026-01-01T00:00:00.123Z' }, { ...preview, actor: { ...actor, userId: 0 } }])('rejects malformed preview envelope', async value => {
    const transport = unpaidCurrencyTransport({ endpoint: '/unmounted-test-only', authenticate: async () => actor, fetch: async () => Response.json(value) });
    await expect(transport.preview()).rejects.toThrow(); expect(storage.reserved).toBe(false);
  });
});
