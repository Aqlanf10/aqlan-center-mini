/** Inactive read kernels. Snapshot mode emits no lock/control SQL and returns only
 * JSON projections. PNG rendering is deliberately a separate legacy-only API. */
import { canonicalJourneyJSON } from './ortho-case-journey-json';
import { readFacialRead, type FacialDocument, type FacialRead } from './ortho-facial-records';
import {
  facialFail, facialId, facialHash, facialQuery, facialOperationData, assertFacialOperation, facialEligibility,
  openFacialOperation, closeFacialOperation, verifyFacialImage, validateFacialBasis,
  type FacialScope, type FacialQuery, type FacialReadPorts, type FacialLegacyReadPorts, type FacialPNGPort,
} from './ortho-facial-core-contract';
import { readFacialSourceWith, readFacialOwnerWith, readStoredFacialRevision } from './ortho-facial-revision-core';
export async function readFacialAnalysisWith(client: FacialQuery, input: FacialScope & { documentId: number | null }, ports: FacialReadPorts): Promise<FacialRead> {
  if (ports.mode !== 'legacy-read' && ports.mode !== 'snapshot-read') facialFail(500, 'facial_core_context_changed');
  const documentId = input.documentId;
  if (!(documentId === null || facialId(documentId))) facialFail(400, 'invalid_scope');
  const operation = await openFacialOperation(client, input, ports);
  try {
    const { actor, scope } = facialOperationData(operation, client, ports);
    await assertFacialOperation(operation, client, ports, true);
    const doc = documentId === null ? null : await readFacialSourceWith(operation, client, ports, documentId);
    const owner = await readFacialOwnerWith(operation, client, ports);
    const listed = await facialQuery<FacialDocument>(operation, client, ports,
      `SELECT id,title,sha256,to_char(taken_on,'YYYY-MM-DD') AS "takenOn" FROM patient_documents
       WHERE patient_id=$1 AND ortho_case_id=$2 AND removed_at IS NULL AND (photo_stage IS NULL OR photo_stage<>'archived') AND photo_view='extraoral_frontal' AND mime_type IN ('image/jpeg','image/png','image/webp') ORDER BY uploaded_at DESC,id DESC LIMIT 101`, [scope.patientId, scope.orthoCaseId], true);
    if (listed.rows.length > 101) facialFail(500, 'facial_history_invalid');
    const documents = listed.rows.slice(0, 100);
    if (doc && !documents.some(d => d.id === doc.id)) {
      documents.pop(); documents.push({ id: doc.id, title: doc.title, sha256: doc.sha256, takenOn: doc.taken_on });
    }
    const image = doc ? await verifyFacialImage(operation, client, ports, doc) : null;
    const rows = doc ? (await facialQuery(operation, client, ports,
      'SELECT * FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND document_id=$2 ORDER BY version DESC LIMIT 31', [owner.orthoCaseId, doc.id], true)).rows : [];
    if (rows.length > 31) facialFail(500, 'facial_history_invalid');
    // Preserve the pinned initial-page behavior: validate 30 exposed rows. The
    // extra sentinel proves truncation only; older-page kernel validates it too.
    const revisions = rows.slice(0, 30).map(row => readStoredFacialRevision(row, owner));
    if (revisions.some(revision => canonicalJourneyJSON(revision.command.content.image) !== canonicalJourneyJSON(image))) facialFail(409, 'facial_image_changed');
    const canWrite = await facialEligibility(operation, client, ports);
    const result: FacialRead = { ok: true, patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId, actorId: actor.userId, canWrite,
      documents, documentsTruncated: listed.rows.length > 100, selectedDocumentId: doc?.id ?? null, image, history: revisions, historyTruncated: rows.length > 30 };
    try { await readFacialRead(result, scope, documentId); } catch { facialFail(500, 'facial_history_invalid'); }
    await assertFacialOperation(operation, client, ports, true);
    return result;
  } finally { closeFacialOperation(operation); }
}
/** Not a canonical snapshot API. Later HTTP boundary must add private/no-store,
 * nosniff and inline PNG headers, and must not expose storage/source bytes in JSON. */
export async function readFacialPNGWith(client: FacialQuery, input: FacialScope & { documentId: number; sha256: string }, ports: FacialLegacyReadPorts, pngPort: FacialPNGPort) {
  if (ports.mode !== 'legacy-read') facialFail(500, 'facial_core_context_changed');
  const documentId = input.documentId, sha256 = input.sha256, render = pngPort.render;
  if (!facialId(documentId) || !facialHash(sha256)) facialFail(400, 'invalid_scope');
  const operation = await openFacialOperation(client, input, ports);
  try {
    await assertFacialOperation(operation, client, ports, true);
    const doc = await readFacialSourceWith(operation, client, ports, documentId);
    await readFacialOwnerWith(operation, client, ports);
    if (doc.sha256 !== sha256) facialFail(409, 'facial_image_changed');
    await assertFacialOperation(operation, client, ports, true);
    const rendered = await render.call(pngPort, doc);
    await assertFacialOperation(operation, client, ports, true);
    if (pngPort.render !== render) facialFail(500, 'facial_core_context_changed');
    validateFacialBasis(rendered.basis, doc);
    if (!Buffer.isBuffer(rendered.png) || rendered.png.length < 8 || rendered.png.length > 64 * 1024 * 1024
      || !rendered.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) facialFail(409, 'facial_image_decode');
    return { ok: true as const, png: rendered.png };
  } finally { closeFacialOperation(operation); }
}
