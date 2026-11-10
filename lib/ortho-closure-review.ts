import type { RetentionLedgerRead } from './ortho-retention-client';
import { readSavedRetentionLedgerContext } from './ortho-retention-saved-context';
import { decodeOrthoRecordDocuments } from './ortho-records';

export type ClosureScope = { patientId: number; orthoCaseId: number };
/** Presentation only, over a verified authorized ledger. This is not a closure
 * policy, a clinical assessment or fresh source authorization. */
export function projectClosureReview(data: RetentionLedgerRead | null, scope: ClosureScope) {
  if (!data || data.scope.patientId !== scope.patientId || data.scope.orthoCaseId !== scope.orthoCaseId) return null;
  const context = readSavedRetentionLedgerContext(data); if (!context) return null;
  return {
    headId: context.binding.headId,
    debonds: context.projection.currentEvents.flatMap(event => event.content.kind === 'debond' ? [{
      eventId: event.id, arch: event.arch, occurrence: { ...event.content.occurrence }, extent: event.content.extent,
    }] : []),
    devices: context.projection.devices.map(device => ({ deviceId: device.deviceId, arch: device.arch,
      type: device.delivery.deviceType, deliveryRevisionId: device.deliveryRevisionId,
      occurrence: { ...device.delivery.occurrence }, currentState: device.currentState,
      replacedDeviceId: device.replacedDeviceId, ambiguityReasons: [...device.ambiguityReasons],
    })),
    sourceEvidence: !context.binding.sourceMatches.length ? 'none' as const
      : context.binding.sourceMatches.some(source => source.identityMatch === false) ? 'mismatch' as const
        : context.binding.sourceMatches.some(source => source.identityMatch === null) ? 'unversioned' as const : 'matched' as const,
  };
}
export const CLOSURE_PHOTO_LIMITS = { bytes: 4 * 1024 * 1024, records: 5000, visibleRows: 20 } as const;
export type ClosurePhoto = { id: number; takenOn: string | null };
export function projectClosurePhotos(raw: unknown, scope: ClosureScope): ClosurePhoto[] {
  if (!raw || typeof raw !== 'object' || !('documents' in raw) || !Array.isArray(raw.documents)
    || raw.documents.length > CLOSURE_PHOTO_LIMITS.records) throw Error('closure_photo_limit');
  // Existing patient-wide endpoint has no pagination. Missing links/unknown
  // stages are never assigned to the selected case or to the debond stage.
  return decodeOrthoRecordDocuments(raw, scope.patientId)
    .filter(row => row.orthoCaseId === scope.orthoCaseId && row.photoStage === 'debond')
    .map(row => ({ id: row.id, takenOn: row.takenOn }));
}
export type ClosurePhotoState = { status: 'idle' | 'loading' | 'denied' | 'unavailable' }
  | { status: 'available'; photos: ClosurePhoto[] };
async function boundedBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.status !== 200 || response.redirected || !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel(); throw Error('closure_photo_read');
  }
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > CLOSURE_PHOTO_LIMITS.bytes)) {
    await response.body?.cancel(); throw Error('closure_photo_limit');
  }
  const reader = response.body?.getReader(); if (!reader) throw Error('closure_photo_body');
  const chunks: Uint8Array[] = []; let count = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const part = await reader.read(); if (signal.aborted) throw Error('closure_photo_aborted'); if (part.done) break;
      count += part.value.byteLength; if (count > CLOSURE_PHOTO_LIMITS.bytes) throw Error('closure_photo_limit'); chunks.push(part.value);
    }
    const bytes = new Uint8Array(count); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}
/** Explicit read only. Retired case/authority lifetimes cannot publish or retry. */
export function createClosurePhotoReader(scope: ClosureScope, active: () => boolean, publish: (state: ClosurePhotoState) => void,
  fetcher: typeof fetch = fetch) {
  let retired = false, sequence = 0, pending: AbortController | null = null;
  return {
    retire() { retired = true; sequence++; pending?.abort(); pending = null; },
    async read() {
      if (retired || !active()) return;
      pending?.abort(); const controller = new AbortController(), attempt = ++sequence; pending = controller;
      const current = () => !retired && sequence === attempt && active();
      publish({ status: 'loading' });
      const timer = setTimeout(() => { if (current()) publish({ status: 'unavailable' }); controller.abort(); }, 15000);
      try {
        const response = await fetcher(`/api/patients/${scope.patientId}/documents`, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        if (!current() || controller.signal.aborted) { await response.body?.cancel(); return; }
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); publish({ status: 'denied' }); return; }
        const photos = projectClosurePhotos(await boundedBody(response, controller.signal), scope);
        if (current() && !controller.signal.aborted) publish({ status: 'available', photos });
      } catch { if (current() && !controller.signal.aborted) publish({ status: 'unavailable' }); }
      finally { clearTimeout(timer); if (pending === controller) pending = null; }
    },
  };
}
