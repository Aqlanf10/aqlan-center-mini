import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  connect: vi.fn(), local: vi.fn(), read: vi.fn(), claim: vi.fn(), fail: vi.fn(), publish: vi.fn(),
  text: vi.fn(), textPptx: vi.fn(), illustrated: vi.fn(), full: vi.fn(), fullPptx: vi.fn(), store: vi.fn(),
}));
vi.mock('../lib/db', () => ({ getPool: () => ({ connect: mocked.connect }), usesSharedLocalDatabaseConnection: mocked.local }));
vi.mock('../lib/ortho-case-study-store', () => ({ getOrthoCaseStudy: mocked.read }));
vi.mock('../lib/ortho-study-export-archive-store', () => ({
  claimStudyExport: mocked.claim, failStudyExport: mocked.fail, publishStudyExport: mocked.publish,
}));
vi.mock('../lib/ortho-study-text-export', () => ({ studyTextPresentation: mocked.text }));
vi.mock('../lib/ortho-study-pptx', () => ({ renderStudyTextPptx: mocked.textPptx }));
vi.mock('../lib/ortho-study-illustrated-store', () => ({ withIllustratedStudy: mocked.illustrated }));
vi.mock('../lib/ortho-study-full-layout', () => ({ fullStudyPresentation: mocked.full }));
vi.mock('../lib/ortho-study-full-pptx', () => ({ renderFullStudyPptx: mocked.fullPptx }));
vi.mock('../lib/ortho-study-export-artifact-storage', () => ({ storeStudyExportArtifact: mocked.store }));
import { runStudyExport } from '../lib/ortho-study-export-runner';

const input = { session: { userId: 7, username: 'synthetic-export-operator', role: 'doctor' as const, expiresAt: 2_000_000_000_000 },
  patientId: 11, orthoCaseId: 12, jobId: 14, expectedGeneration: 0 };
const scope = { patientId: 11, orthoCaseId: 12, clinicalCaseId: 13 };
const lease = { jobId: 14, generation: 1, token: '11111111-1111-4111-8111-111111111111', expiresAt: '2030-01-01T00:00:00.000Z' };
const bytes = new Uint8Array([80, 75, 3, 4, 5]);
const reference = { storageKey: `aa/aa/${'a'.repeat(64)}.pptx`, sha256: 'a'.repeat(64), sizeBytes: bytes.length };
const ready = { ok: true, job: { id: 14, state: 'ready', generation: 1 } };
const denied = { ok: false, status: 403, code: 'study_export_forbidden' };
const claimed = (format = 'text-pptx') => ({ ok: true, lease, revision: { id: 21 }, scope,
  job: { id: 14, state: 'running', format, generation: 1 } });

function slot() {
  return Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => ({ rows: sql.includes('pg_try_advisory_lock') ? [{ locked: true }]
      : sql.includes('pg_advisory_unlock') ? [{ unlocked: true }] : [{ '?column?': 1 }] })),
    release: vi.fn((_destroy?: boolean) => undefined),
  });
}
let client: ReturnType<typeof slot>;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('DB_POOL_MAX', '3');
  client = slot(); mocked.connect.mockResolvedValue(client); mocked.local.mockReturnValue(false);
  mocked.read.mockResolvedValue({ ok: true }); mocked.claim.mockResolvedValue(claimed());
  mocked.fail.mockResolvedValue({ ok: true, job: { id: 14, state: 'failed' } }); mocked.publish.mockResolvedValue(ready);
  mocked.text.mockReturnValue({ pages: [{}, {}] }); mocked.textPptx.mockResolvedValue(bytes);
  mocked.full.mockResolvedValue({ pages: [{}, {}, {}] }); mocked.fullPptx.mockResolvedValue(bytes);
  mocked.illustrated.mockImplementation(async (_owner, consume) => ({ ok: true, output: await consume({ pages: [] }) }));
  mocked.store.mockResolvedValue(reference);
});
afterEach(() => vi.unstubAllEnvs());

describe('authenticated archive runner failure boundaries', () => {
  it('returns only a private durable receipt and releases its dedicated render slot', async () => {
    expect(await runStudyExport(input)).toEqual(ready);
    expect(mocked.read).toHaveBeenCalledWith({ ...input, exportAccess: true });
    expect(mocked.publish).toHaveBeenCalledWith({ ...input, lease, artifact: { ...reference, pageCount: 2, renditions: [] } });
    expect(client.query.mock.calls.map(call => call[0])).toEqual([
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', 'SELECT 1',
      'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
    ]);
    expect(client.release).toHaveBeenCalledWith(false); expect(client.listenerCount('error')).toBe(0);
  });
  it.each(['1', '1.0'])('refuses a one-connection pool (%s) before checkout instead of waiting on itself', async maximum => {
    vi.stubEnv('DB_POOL_MAX', maximum);
    expect(await runStudyExport(input)).toMatchObject({ ok: false, code: 'study_export_runtime_unavailable' });
    expect(mocked.connect).not.toHaveBeenCalled(); expect(mocked.claim).not.toHaveBeenCalled();
    vi.stubEnv('DB_POOL_MAX', '3'); expect(await runStudyExport(input)).toEqual(ready);
  });
  it('refuses shared local SQL and unobservable clients without claiming a job', async () => {
    mocked.local.mockReturnValueOnce(true);
    expect(await runStudyExport(input)).toMatchObject({ ok: false, code: 'study_export_runtime_unavailable' });
    expect(mocked.connect).not.toHaveBeenCalled();
    const unsupported = { query: vi.fn(), release: vi.fn() };
    mocked.connect.mockResolvedValueOnce(unsupported);
    expect(await runStudyExport(input)).toMatchObject({ ok: false, code: 'study_export_runtime_unavailable' });
    expect(unsupported.release).toHaveBeenCalledWith(true); expect(mocked.claim).not.toHaveBeenCalled();
    expect(await runStudyExport(input)).toEqual(ready);
  });
  it('handles a dropped checked-out connection during encoding without storage or publication', async () => {
    mocked.textPptx.mockImplementationOnce(async () => {
      expect(client.listenerCount('error')).toBe(1);
      client.emit('error', Error('private database connection detail'));
      return bytes;
    });
    const result = await runStudyExport(input);
    expect(result).toMatchObject({ ok: false, code: 'study_export_failed' });
    expect(JSON.stringify(result)).not.toContain('private database');
    expect(mocked.store).not.toHaveBeenCalled(); expect(mocked.publish).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledWith(true); expect(client.listenerCount('error')).toBe(0);
  });
  it('keeps already written bytes private if the slot connection is lost during storage', async () => {
    mocked.store.mockImplementationOnce(async () => { client.emit('error', Error('private socket failure')); return reference; });
    expect(await runStudyExport(input)).toMatchObject({ ok: false, code: 'study_export_failed' });
    expect(mocked.store).toHaveBeenCalledTimes(1); expect(mocked.publish).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.query.mock.calls.some(call => call[0].includes('pg_advisory_unlock'))).toBe(false);
  });
  it('refuses publication when the post-storage slot health query fails', async () => {
    const actual = client.query.getMockImplementation()!;
    client.query.mockImplementation(async sql => { if (sql === 'SELECT 1') throw Error('private failed connection'); return actual(sql); });
    expect(await runStudyExport(input)).toMatchObject({ ok: false, code: 'study_export_failed' });
    expect(mocked.publish).not.toHaveBeenCalled();
  });
  it('preserves an uncertain publication without changing its durable outcome to failed', async () => {
    mocked.publish.mockRejectedValueOnce(Error('COMMIT reply lost: private detail'));
    const result = await runStudyExport(input);
    expect(result).toEqual({ ok: false, status: 409, code: 'study_export_publication_unconfirmed' });
    expect(mocked.store).toHaveBeenCalledTimes(1); expect(mocked.fail).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/storageKey|private detail|bytes/);
    // Recovery re-reads the durable receipt. A completed job is not encoded/stored again.
    mocked.claim.mockResolvedValueOnce({ ...claimed(), job: ready.job, lease: null, revision: null });
    expect(await runStudyExport(input)).toEqual(ready);
    expect(mocked.store).toHaveBeenCalledTimes(1); expect(mocked.publish).toHaveBeenCalledTimes(1);
  });
  it('destroys a client after unlock failure and permits the next run', async () => {
    const actual = client.query.getMockImplementation()!;
    client.query.mockImplementation(async sql => { if (sql.includes('pg_advisory_unlock')) throw Error('private unlock failure'); return actual(sql); });
    expect(await runStudyExport(input)).toEqual(ready); expect(client.release).toHaveBeenCalledWith(true);
    const next = slot(); mocked.connect.mockResolvedValueOnce(next);
    expect(await runStudyExport(input)).toEqual(ready); expect(next.release).toHaveBeenCalledWith(false);
  });
  it('clears process admission even if release itself throws after a confirmed publication', async () => {
    client.release.mockImplementationOnce(() => { throw Error('synthetic release failure'); });
    await expect(runStudyExport(input)).rejects.toThrow('synthetic release failure');
    expect(client.listenerCount('error')).toBe(0); expect(mocked.fail).not.toHaveBeenCalled();
    const next = slot(); mocked.connect.mockResolvedValueOnce(next);
    expect(await runStudyExport(input)).toEqual(ready);
  });
  it.each([denied, { ok: false, status: 401, code: 'session_expired' }])('denies revoked admission before acquiring a slot or producing bytes', async refusal => {
    mocked.read.mockResolvedValueOnce(refusal);
    expect(await runStudyExport(input)).toEqual(refusal);
    expect(mocked.connect).not.toHaveBeenCalled(); expect(mocked.textPptx).not.toHaveBeenCalled();
    expect(mocked.store).not.toHaveBeenCalled(); expect(mocked.publish).not.toHaveBeenCalled();
  });
  it('honors the illustrated adapter final authority refusal after encoding without storing bytes', async () => {
    mocked.claim.mockResolvedValueOnce(claimed('illustrated-pptx'));
    mocked.illustrated.mockImplementationOnce(async (_owner, consume) => { await consume({ pages: [] }); return denied; });
    mocked.fail.mockResolvedValueOnce(denied);
    expect(await runStudyExport(input)).toEqual(denied);
    expect(mocked.fullPptx).toHaveBeenCalledTimes(1); expect(mocked.store).not.toHaveBeenCalled();
    expect(mocked.publish).not.toHaveBeenCalled();
  });
  it('returns only the canonical publication refusal if permission changes after private storage', async () => {
    mocked.publish.mockResolvedValueOnce(denied);
    expect(await runStudyExport(input)).toEqual(denied);
    expect(mocked.store).toHaveBeenCalledTimes(1); expect(mocked.fail).not.toHaveBeenCalled();
  });
});
