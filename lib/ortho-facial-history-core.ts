/** Inactive bounded historical read, shared by lock-free and legacy locked ports. */
import { FACIAL_HISTORY_LIMITS, facialHistoryBytes, verifyFacialHistoryPage, type FacialHistoryPage } from './ortho-facial-history';
import { canonicalJourneyJSON } from './ortho-case-journey-json';
import {
  facialFail, facialId, facialHash, facialQuery, facialOperationData, assertFacialOperation,
  openFacialOperation, closeFacialOperation, verifyFacialImage,
  type FacialScope, type FacialQuery, type FacialReadPorts,
} from './ortho-facial-core-contract';
import { readFacialSourceWith, readFacialOwnerWith, readStoredFacialRevision } from './ortho-facial-revision-core';
export interface FacialHistoryRequest extends FacialScope { documentId: number; beforeRevisionId: number; beforeContentHash: string }
function rawBytes(value: unknown) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { facialFail(500, 'facial_history_invalid'); }
}
export async function readFacialHistoryWith(client: FacialQuery, input: FacialHistoryRequest, ports: FacialReadPorts): Promise<FacialHistoryPage> {
  if (ports.mode !== 'legacy-read' && ports.mode !== 'snapshot-read') facialFail(500, 'facial_core_context_changed');
  const documentId = input.documentId, beforeRevisionId = input.beforeRevisionId, beforeContentHash = input.beforeContentHash;
  if (![documentId, beforeRevisionId].every(facialId) || !facialHash(beforeContentHash)) facialFail(400, 'invalid_history_cursor');
  const operation = await openFacialOperation(client, input, ports);
  try {
    const { actor } = facialOperationData(operation, client, ports);
    await assertFacialOperation(operation, client, ports, true);
    const doc = await readFacialSourceWith(operation, client, ports, documentId), owner = await readFacialOwnerWith(operation, client, ports);
    const image = await verifyFacialImage(operation, client, ports, doc);
    const { rows: anchors } = await facialQuery(operation, client, ports,
      'SELECT * FROM ortho_facial_revisions WHERE id=$1 AND ortho_case_id=$2 AND document_id=$3', [beforeRevisionId, owner.orthoCaseId, doc.id], true, raw => {
        if (raw.length > 1) facialFail(500, 'facial_history_invalid');
        if (raw.length && rawBytes(raw[0]) > FACIAL_HISTORY_LIMITS.rowBytes) facialFail(413, 'facial_history_too_large');
      });
    if (!anchors.length) facialFail(404, 'facial_history_anchor_unavailable');
    if (anchors.length !== 1) facialFail(500, 'facial_history_invalid');
    if (rawBytes(anchors[0]) > FACIAL_HISTORY_LIMITS.rowBytes) facialFail(413, 'facial_history_too_large');
    const anchor = readStoredFacialRevision(anchors[0], owner);
    if (anchor.id !== beforeRevisionId || anchor.documentId !== doc.id) facialFail(500, 'facial_history_invalid');
    if (anchor.contentHash !== beforeContentHash) facialFail(409, 'facial_history_anchor_changed');
    const { rows } = await facialQuery(operation, client, ports,
      'SELECT * FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND document_id=$2 AND version<$3 ORDER BY version DESC LIMIT 31', [owner.orthoCaseId, doc.id, anchor.version], true, raw => {
        if (raw.length > FACIAL_HISTORY_LIMITS.rows + 1) facialFail(500, 'facial_history_invalid');
        if (rawBytes([anchors[0], ...raw.slice(0, FACIAL_HISTORY_LIMITS.rows)]) > FACIAL_HISTORY_LIMITS.pageBytes) facialFail(413, 'facial_history_too_large');
        for (const row of raw) if (rawBytes(row) > FACIAL_HISTORY_LIMITS.rowBytes) facialFail(413, 'facial_history_too_large');
      });
    if (rows.length > FACIAL_HISTORY_LIMITS.rows + 1) facialFail(500, 'facial_history_invalid');
    if (rawBytes([anchors[0], ...rows.slice(0, FACIAL_HISTORY_LIMITS.rows)]) > FACIAL_HISTORY_LIMITS.pageBytes) facialFail(413, 'facial_history_too_large');
    const history = []; let previous = anchor;
    const ids = new Set<number>([anchor.id]);
    for (const row of rows) {
      if (rawBytes(row) > FACIAL_HISTORY_LIMITS.rowBytes) facialFail(413, 'facial_history_too_large');
      const revision = readStoredFacialRevision(row, owner);
      if (canonicalJourneyJSON(revision.command.content.image) !== canonicalJourneyJSON(image)) facialFail(409, 'facial_image_changed');
      if (revision.documentId !== doc.id || ids.has(revision.id) || revision.version !== previous.version - 1 || previous.command.expectedHeadId !== revision.id) facialFail(500, 'facial_history_invalid');
      ids.add(revision.id); previous = revision;
      if (history.length < FACIAL_HISTORY_LIMITS.rows) history.push(revision);
    }
    const hasMore = rows.length > FACIAL_HISTORY_LIMITS.rows;
    if (!hasMore && previous.version !== 1) facialFail(500, 'facial_history_invalid');
    const result: FacialHistoryPage = { ok: true, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId, actorId: actor.userId, documentId: doc.id, image, anchor, history, hasMore };
    if ([anchor, ...history].some(revision => canonicalJourneyJSON(revision.command.content.image) !== canonicalJourneyJSON(image))) facialFail(409, 'facial_image_changed');
    if ([anchor, ...history].some(revision => facialHistoryBytes(revision) > FACIAL_HISTORY_LIMITS.rowBytes) || facialHistoryBytes(result) > FACIAL_HISTORY_LIMITS.pageBytes) facialFail(413, 'facial_history_too_large');
    try { await verifyFacialHistoryPage(result, { ...owner, actorId: actor.userId, documentId: doc.id, anchor }); } catch { facialFail(500, 'facial_history_invalid'); }
    await assertFacialOperation(operation, client, ports, true);
    return result;
  } finally { closeFacialOperation(operation); }
}
