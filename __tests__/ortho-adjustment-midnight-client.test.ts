import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), found: vi.fn(), write: vi.fn() }));
vi.mock('@/lib/session', () => ({ requireSession: mocks.session }));
vi.mock('@/lib/patient-access', () => ({ canAccessPatient: mocks.access }));
vi.mock('@/lib/db', () => ({ CLINIC_TIME_ZONE: 'Asia/Aden', getOrthoCase: mocks.found, recordAdjustment: mocks.write }));
import { POST } from '../app/api/ortho/[id]/route';
import { adjustmentCommandStorageKey, readAdjustmentCommand, completeAdjustmentCommand, isAdjustmentReceipt, type AdjustmentCommand } from '../lib/ortho-adjustment-command';
const key = 'synthetic-midnight-adjustment-001';
const scope = { patientId: 101, caseId: 41, authority: 'synthetic-actor-7' };
const fields = { upperWire: '', lowerWire: '', elastics: 'none', elasticNote: '', done: 'Synthetic procedure', nextWeeks: 4 };
const call = (body: unknown) => POST(new Request('https://synthetic.invalid/api/ortho/41', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: '41' }) });
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T20:59:00Z'));
  mocks.session.mockResolvedValue({ userId: 7, username: 'synthetic-doctor', role: 'doctor', expiresAt: 4_102_444_800_000 });
  mocks.access.mockResolvedValue(true); mocks.found.mockResolvedValue({ id: 41, patientId: 101 });
  // Deliberately mocked replay boundary. No journal/hash/invoice/locking proof.
  mocks.write.mockResolvedValue({ ok: true, id: 501, created: false, replayed: true, visitId: null, attachedToToday: false });
});
afterEach(() => vi.useRealTimers());
describe('midnight route admission and frozen client receipt boundaries', () => {
  it.each([undefined, null])('marks only omitted/null date %j for historical replay, ignoring forged false flags', async doneOn => {
    const payload = { ...fields, ...(doneOn === undefined ? {} : { doneOn }), omittedDateForReplay: false, request: { omittedDateForReplay: false } };
    expect((await call(payload)).status).toBe(200);
    vi.setSystemTime(new Date('2026-11-06T21:01:00Z'));
    expect((await call(payload)).status).toBe(200);
    expect(mocks.write.mock.calls.map(([input]) => input.doneOn)).toEqual(['2026-11-06', '2026-11-07']);
    for (const [input] of mocks.write.mock.calls) expect(input.request).toMatchObject({ key, patientId: 101, omittedDateForReplay: true, newDateAdmissionError: null });
  });
  it.each(['2026-11-06', '', 'bad-date', '2026-02-30', '0000-01-01', false, 0, {}])('does not grant fallback to explicit date %j despite forged true flags', async doneOn => {
    await call({ ...fields, doneOn, omittedDateForReplay: true, request: { omittedDateForReplay: true } });
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.write.mock.calls[0][0].request.omittedDateForReplay).toBe(false);
    expect(mocks.write.mock.calls[0][0].request.newDateAdmissionError).toEqual(doneOn === '2026-11-06' ? null : expect.any(String));
  });
  it('retains exact explicit frozen date/body/key across midnight and accepts the real route receipt', async () => {
    const map = new Map<string, string>(); const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
    const command: AdjustmentCommand = { version: 1, scope, key, body: JSON.stringify({ ...fields, doneOn: '2026-11-06' }), receipt: null };
    store.setItem(adjustmentCommandStorageKey(scope), JSON.stringify(command));
    for (const instant of ['2026-11-06T20:59:00Z', '2026-11-06T21:01:00Z']) {
      vi.setSystemTime(new Date(instant)); const recovered = readAdjustmentCommand(store, scope)!;
      const response = await call(JSON.parse(recovered.body)); expect(response.status).toBe(200);
      const receipt = await response.json(); expect(isAdjustmentReceipt(receipt, recovered)).toBe(true);
      const completed = completeAdjustmentCommand(store, recovered, receipt);
      expect(completed.body).toBe(command.body); expect(completed.key).toBe(command.key);
    }
    expect(mocks.write.mock.calls.map(([input]) => input.doneOn)).toEqual(['2026-11-06', '2026-11-06']);
    expect(mocks.write.mock.calls.every(([input]) => input.request.omittedDateForReplay === false)).toBe(true);
  });
  it('cannot acknowledge a server replay conflict or mutate frozen storage', async () => {
    const command: AdjustmentCommand = { version: 1, scope, key, body: JSON.stringify({ ...fields, doneOn: '2026-11-06' }), receipt: null };
    const raw = JSON.stringify(command); const write = vi.fn();
    mocks.write.mockResolvedValue({ ok: false, status: 409, code: 'adjustment_request_conflict', message: 'Synthetic conflict' });
    vi.setSystemTime(new Date('2026-11-06T21:01:00Z'));
    const response = await call(JSON.parse(command.body)); expect(response.status).toBe(409);
    const refusal = await response.json(); expect(isAdjustmentReceipt(refusal, command)).toBe(false);
    expect(() => completeAdjustmentCommand({ getItem: () => raw, setItem: write, removeItem: vi.fn() }, command, refusal)).toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it('does not invent omitted-date support in the frozen UI reader', () => {
    for (const doneOn of [undefined, null]) {
      const raw = JSON.stringify({ version: 1, scope, key, body: JSON.stringify({ ...fields, doneOn }), receipt: null });
      expect(() => readAdjustmentCommand({ getItem: () => raw, setItem: vi.fn(), removeItem: vi.fn() }, scope)).toThrow();
    }
  });
  it('keeps current patient denial ahead of any replay attempt', async () => {
    mocks.access.mockResolvedValue(false); expect((await call(fields)).status).toBe(403); expect(mocks.write).not.toHaveBeenCalled();
  });
});
