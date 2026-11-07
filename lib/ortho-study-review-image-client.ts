import { CASE_PAGE, caseLayout } from './ortho-case-template';
import { canonicalOrthoMediaGeometryWitness, canonicalOrthoMediaRecipe, parseOrthoStudyMediaUseDraft } from './ortho-study-media';
import { STUDY_IMAGE_LIMITS, STUDY_IMAGE_PROCESSOR } from './ortho-study-image-contract';
import type { StudyEditorRevision } from './ortho-case-study-editor-contract';
export class SavedStudyImageDenied extends Error {}
export function savedStudyImageRequest(revision: StudyEditorRevision, actorId: number, panelId: string, useId: string, slot: string) {
  const panel = revision.authored.panels.find(p => p.instanceId === panelId);
  const binding = panel?.images.find(i => i.useId === useId && i.slot === slot);
  const raw = revision.authored.mediaUses.find(u => u.useId === useId);
  const box = panel && caseLayout(panel.layoutKey)?.images.find(i => i.slotId === slot);
  if (!panel || panel.state !== 'available' || !binding || !raw || !box) throw Error('study_saved_image_binding');
  const use = parseOrthoStudyMediaUseDraft(raw);
  if (!revision.authored.sources.some(s => panel.sourceKeys.includes(s.key) && s.kind === 'document' && s.id === use.documentId && s.contentHash === use.sourceSha256)) throw Error('study_saved_image_source');
  const frame = { width: Math.ceil(box.w * CASE_PAGE.imageDpi), height: Math.ceil(box.h * CASE_PAGE.imageDpi) };
  return { patientId: revision.patientId, orthoCaseId: revision.orthoCaseId, clinicalCaseId: revision.clinicalCaseId,
    revisionId: revision.id, revisionHash: revision.contentHash, actorId, panelId, slot, use, frame };
}
export type SavedStudyImageRequest = ReturnType<typeof savedStudyImageRequest>;
const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)), b => b.toString(16).padStart(2, '0')).join('');
export async function fetchSavedStudyImage(input: SavedStudyImageRequest, signal: AbortSignal): Promise<Blob> {
  const current = () => { if (signal.aborted) throw Error('study_saved_image_aborted'); };
  current();
  const query = new URLSearchParams({ patientId: String(input.patientId), clinicalCaseId: String(input.clinicalCaseId), revisionId: String(input.revisionId), revisionHash: input.revisionHash, panelId: input.panelId, useId: input.use.useId, slot: input.slot });
  const response = await fetch(`/api/ortho/${input.orthoCaseId}/case-study/review-image?${query}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal });
  current();
  if ([401, 403].includes(response.status)) throw new SavedStudyImageDenied();
  const h = response.headers, policies = (h.get('cache-control') ?? '').split(',').map(s => s.trim().toLowerCase());
  if (response.status !== 200 || response.redirected || !policies.includes('private') || !policies.includes('no-store') || policies.includes('public') || h.get('content-type') !== 'image/png') throw Error('study_saved_image_response');
  const expected = { patient: input.patientId, case: input.orthoCaseId, 'clinical-case': input.clinicalCaseId, actor: input.actorId,
    revision: input.revisionId, 'revision-sha256': input.revisionHash, panel: input.panelId, slot: input.slot,
    document: input.use.documentId, use: input.use.useId, purpose: 'selected-use', 'source-sha256': input.use.sourceSha256,
    processor: STUDY_IMAGE_PROCESSOR, width: input.frame.width, height: input.frame.height };
  for (const [key, value] of Object.entries(expected)) if (h.get(`x-study-${key}`) !== String(value)) throw Error('study_saved_image_identity');
  const encoder = new TextEncoder();
  if (h.get('x-study-recipe-sha256') !== await sha256(encoder.encode(canonicalOrthoMediaRecipe(input.use.recipe)))
    || h.get('x-study-geometry-sha256') !== await sha256(encoder.encode(canonicalOrthoMediaGeometryWitness(input.use.recipe, input.frame)))) throw Error('study_saved_image_recipe');
  current();
  const length = h.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > STUDY_IMAGE_LIMITS.outputBytes)) throw Error('study_saved_image_limit');
  const reader = response.body?.getReader(); if (!reader) throw Error('study_saved_image_body');
  const chunks: Uint8Array[] = []; let total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      current(); const part = await reader.read(); current(); if (part.done) break;
      total += part.value.byteLength; if (total > STUDY_IMAGE_LIMITS.outputBytes) throw Error('study_saved_image_limit');
      chunks.push(part.value);
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (total < 24 || length !== null && total !== Number(length)) throw Error('study_saved_image_length');
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const view = new DataView(bytes.buffer);
  if ([137,80,78,71,13,10,26,10].some((v, i) => bytes[i] !== v) || view.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12,16)) !== 'IHDR'
    || view.getUint32(16) !== input.frame.width || view.getUint32(20) !== input.frame.height) throw Error('study_saved_image_png');
  if (await sha256(bytes) !== h.get('x-study-rendition-sha256')) throw Error('study_saved_image_digest');
  current(); return new Blob([bytes], { type: 'image/png' });
}
