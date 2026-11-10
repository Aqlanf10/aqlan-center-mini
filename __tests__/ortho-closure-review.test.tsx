import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { OrthoClosureReview } from '../components/OrthoClosureReview';
import { createClosurePhotoReader, CLOSURE_PHOTO_LIMITS, projectClosurePhotos, projectClosureReview, type ClosurePhotoState } from '../lib/ortho-closure-review';
import { retentionHash, verifyRetentionRead } from '../lib/ortho-retention-client';
import { projectRetentionEventHistory, type RetentionEventRecord } from '../lib/ortho-retention-event-history';
const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 }, actorId = 4;
const occurrence = (occurredOn: string | null) => ({ occurredOn, dateProvenance: occurredOn ? 'historical_source' as const : 'unknown' as const, sourceNote: 'Synthetic historical evidence' });
function delivery(id: number, arch: RetentionEventRecord['arch'] = 'upper', date: string | null = null): RetentionEventRecord {
  return { id, version: id, arch, supersedesEntryId: null, archCorrectionReason: null, content: { kind: 'device_delivery',
    occurrence: occurrence(date), note: '', documentIds: [], deviceType: 'fixed', description: 'Synthetic delivery', extent: 'Synthetic extent', labOrderId: null } };
}
async function ledger(records: RetentionEventRecord[], match: boolean | null = true) {
  const history = await Promise.all([...records].sort((a,b) => b.version-a.version).map(async (row, index, all) => {
    const content = { arch: row.arch, supersedesEntryId: row.supersedesEntryId, archCorrectionReason: row.archCorrectionReason, payload: row.content,
      ...(match === null ? {} : { savedVersion: 2, documentWitnesses: row.content.documentIds.map(id => ({ id, patientId: 1, orthoCaseId: 2, sha256: 'a'.repeat(64), metadataHash: 'b'.repeat(64) })) }) };
    return { ...scope, id: row.id, recordedPatientId: 1, schemaVersion: 1, version: row.version, predecessorId: all[index+1]?.id ?? null,
      createdBy: 'Synthetic recorder', createdAt: '2026-11-10T00:00:00Z', reason: 'Synthetic evidence', recordingContext: 'current', caseStatusAtCapture: 'active', contentHash: await retentionHash(content), content };
  }));
  const projection = projectRetentionEventHistory(records); if (!projection.ok) throw Error(projection.code);
  const read = await verifyRetentionRead({ ok: true, scope, actorId, writable: true, headId: history[0]?.id ?? null, history, ...projection.value,
    sourceMatches: history.flatMap(row => row.content.payload.documentIds.map(documentId => ({ entryId: row.id, documentId, identityMatch: match }))) }, 1, 2, { scope, actorId });
  if (!read) throw Error('Invalid synthetic ledger'); return read;
}
const document = (id: number, patch = {}) => ({ id, patientId: 1, orthoCaseId: 2, title: 'Synthetic metadata', note: null, isImage: true,
  photoStage: 'debond', photoView: 'extraoral_frontal', takenOn: null, uploadedAt: '2026-11-10T00:00:00Z', removedAt: null, ...patch });
const reply = (documents = [document(1)], status = 200) => new Response(JSON.stringify({ documents }), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve!: (response: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());
it('distinguishes empty verified history from unavailable and mismatched scope', async () => {
  const empty = await ledger([]); expect(projectClosureReview(empty, scope)).toMatchObject({ headId: null, debonds: [], devices: [], sourceEvidence: 'none' });
  expect(projectClosureReview(null, scope)).toBeNull(); expect(projectClosureReview(empty, { ...scope, orthoCaseId: 7 })).toBeNull();
});
it('keeps independent device dates and unknown use, without inferring debond or readiness', async () => {
  const data = await ledger([delivery(1, 'upper', '2025-04-01'), delivery(2, 'lower')]), before = structuredClone(data);
  const result = projectClosureReview(data, scope)!;
  expect(result.debonds).toEqual([]); expect(result.devices).toHaveLength(2);
  expect(result.devices[0]).toMatchObject({ deviceId: 1, arch: 'upper', occurrence: { occurredOn: '2025-04-01' }, currentState: 'unknown' });
  expect(result.devices[1]).toMatchObject({ deviceId: 2, arch: 'lower', occurrence: { occurredOn: null }, currentState: 'ambiguous' });
  expect(result).not.toHaveProperty('ready'); expect(result).not.toHaveProperty('canClose');
  result.devices[0].occurrence.sourceNote = 'Changed local copy'; expect(data).toEqual(before);
});
it('uses corrected documentary events without rewriting the original evidence', async () => {
  const first: RetentionEventRecord = { ...delivery(1), content: { kind: 'debond', occurrence: occurrence(null), note: '', documentIds: [], extent: 'Initial extent' } };
  const corrected: RetentionEventRecord = { ...first, id: 2, version: 2, supersedesEntryId: 1, content: { kind: 'debond', occurrence: occurrence(null), note: '', documentIds: [], extent: 'Corrected extent' } };
  const data = await ledger([first, corrected]), before = structuredClone(data), result = projectClosureReview(data, scope)!;
  expect(result.debonds).toEqual([{ eventId: 2, arch: 'upper', occurrence: occurrence(null), extent: 'Corrected extent' }]);
  expect(data).toEqual(before); expect(data.history).toHaveLength(2);
  expect(projectClosureReview({ ...data, currentEvents: [] }, scope)).toBeNull();
});
it.each([[true, 'matched'], [false, 'mismatch'], [null, 'unversioned']] as const)('preserves source evidence %s without clinical upgrade', async (match, expected) => {
  const row = delivery(1); row.content.documentIds = [8];
  expect(projectClosureReview(await ledger([row], match), scope)?.sourceEvidence).toBe(expected);
});
it('filters records by explicit case/stage and preserves unknown acquisition dates', () => {
  const documents = [document(1), document(2, { orthoCaseId: null }), document(3, { orthoCaseId: 7 }), document(4, { photoStage: 'retention' }),
    document(5, { photoStage: null }), document(6, { removedAt: '2026-11-01' }), document(7, { photoStage: 'archived' }), document(8, { isImage: false })];
  expect(projectClosurePhotos({ documents }, scope)).toEqual([{ id: 1, takenOn: null }]);
  expect(projectClosurePhotos({ documents: [] }, scope)).toEqual([]);
  expect(() => projectClosurePhotos({ documents: [document(1, { patientId: 7 })] }, scope)).toThrow();
  expect(() => projectClosurePhotos({ documents: Array(CLOSURE_PHOTO_LIMITS.records + 1).fill(document(1)) }, scope)).toThrow('closure_photo_limit');
});
it('performs no automatic request and makes only the canonical authenticated GET', async () => {
  const states: ClosurePhotoState[] = [], fetcher = vi.fn(async () => reply());
  const reader = createClosurePhotoReader(scope, () => true, state => states.push(state), fetcher);
  expect(fetcher).not.toHaveBeenCalled(); await reader.read();
  expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]).toEqual([`/api/patients/1/documents`, expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal) })]);
  expect(states).toEqual([{ status: 'loading' }, { status: 'available', photos: [{ id: 1, takenOn: null }] }]); reader.retire();
});
it.each([401, 403])('clears previous photos before an authority denial %i', async status => {
  const states: ClosurePhotoState[] = [], fetcher = vi.fn().mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply([], status));
  const reader = createClosurePhotoReader(scope, () => true, state => states.push(state), fetcher);
  await reader.read(); await reader.read(); expect(states.slice(-2)).toEqual([{ status: 'loading' }, { status: 'denied' }]); reader.retire();
});
it('retires in-flight scope reads and retained callbacks without publishing old data', async () => {
  const held = deferred(), states: ClosurePhotoState[] = [], fetcher = vi.fn(() => held.promise);
  const reader = createClosurePhotoReader(scope, () => true, state => states.push(state), fetcher), pending = reader.read();
  reader.retire(); held.resolve(reply()); await pending; await reader.read();
  expect(fetcher).toHaveBeenCalledOnce(); expect(states).toEqual([{ status: 'loading' }]);
});
it('suppresses completion after the parent lease is no longer active', async () => {
  let active = true; const held = deferred(), states: ClosurePhotoState[] = [];
  const reader = createClosurePhotoReader(scope, () => active, state => states.push(state), vi.fn(() => held.promise)), pending = reader.read();
  active = false; held.resolve(reply()); await pending; await reader.read(); expect(states).toEqual([{ status: 'loading' }]); reader.retire();
});
it('a newer read aborts and supersedes the earlier result', async () => {
  const held = deferred(), states: ClosurePhotoState[] = [], fetcher = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce(reply([document(2)]));
  const reader = createClosurePhotoReader(scope, () => true, state => states.push(state), fetcher), old = reader.read();
  await reader.read(); held.resolve(reply()); await old;
  expect(states.at(-1)).toEqual({ status: 'available', photos: [{ id: 2, takenOn: null }] }); expect(states.filter(state => state.status === 'available')).toHaveLength(1); reader.retire();
});
it.each(['failed', 'malformed', 'oversize'])('keeps %s reads unavailable rather than empty', async kind => {
  const states: ClosurePhotoState[] = [], fetcher = vi.fn(async () => kind === 'failed' ? reply([], 500)
    : kind === 'malformed' ? new Response('{}', { headers: { 'content-type': 'application/json' } })
      : new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(CLOSURE_PHOTO_LIMITS.bytes + 1) } }));
  const reader = createClosurePhotoReader(scope, () => true, state => states.push(state), fetcher);
  await reader.read(); expect(states.at(-1)).toEqual({ status: 'unavailable' }); reader.retire();
});
it('cancels an oversized streaming body even without a content-length header', async () => {
  const cancel = vi.fn(), states: ClosurePhotoState[] = [];
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(CLOSURE_PHOTO_LIMITS.bytes + 1)); }, cancel });
  const reader = createClosurePhotoReader(scope, () => true, state => states.push(state),
    vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } })));
  await reader.read(); expect(states.at(-1)).toEqual({ status: 'unavailable' }); expect(cancel).toHaveBeenCalledOnce(); reader.retire();
});
it('bounds a stalled read and refuses its late response', async () => {
  vi.useFakeTimers(); const held = deferred(), states: ClosurePhotoState[] = [];
  const reader = createClosurePhotoReader(scope, () => true, state => states.push(state), vi.fn(() => held.promise)), pending = reader.read();
  await vi.advanceTimersByTimeAsync(15000); expect(states.at(-1)).toEqual({ status: 'unavailable' });
  held.resolve(reply()); await pending; expect(states.at(-1)).toEqual({ status: 'unavailable' }); reader.retire();
});
it('renders an explicit documentary review without closure controls, image URLs or inferred completeness', async () => {
  const data = await ledger([delivery(1)]);
  const props = { ...scope, ledger: data, readUnavailable: false, legacyRetainer: null, legacyDate: null, authority: 'synthetic', readVersion: 1,
    ownerIdentity: {}, active: () => true, photosVisible: true };
  const html = renderToStaticMarkup(<OrthoClosureReview {...props} />);
  expect(html).toContain('بيانات المثبّت القديمة: غير مسجلة'); expect(html).toContain('تاريخ الواقعة غير معلوم'); expect(html).toContain('أجهزة التثبيت المسجلة');
  expect(html).toContain('صور مسجّلة لمرحلة فك الجهاز'); expect(html).toContain('لم تُقرأ بيانات الصور'); expect(html).toContain('لا يثبت اكتمال العلاج');
  expect(html).toContain('orthoCaseId=2'); expect(html).toContain('pillar=diagnostics'); expect(html).not.toContain('<img'); expect(html).not.toContain('/api/documents/');
  expect(html).not.toContain('أغلق الحالة'); expect(html).not.toContain('جاهزة للإغلاق');
  expect(renderToStaticMarkup(<OrthoClosureReview {...props} active={() => false} />)).toBe('');
  const unavailable = renderToStaticMarkup(<OrthoClosureReview {...props} ledger={null} readUnavailable />);
  const stale = renderToStaticMarkup(<OrthoClosureReview {...props} readUnavailable />);
  expect(stale).toContain('لا يُعد فارغاً'); expect(stale).not.toContain('جهاز #1'); expect(stale).not.toContain('قراءة صور مرحلة فك الجهاز');
  expect(unavailable).toContain('لا يُعد فارغاً'); expect(unavailable).not.toContain('لا توجد واقعة تسليم'); expect(unavailable).not.toContain('قراءة صور مرحلة فك الجهاز');
});
