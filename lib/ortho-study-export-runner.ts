import { getPool, usesSharedLocalDatabaseConnection, type DbClient } from './db';
import type { JourneyOwnerInput } from './ortho-case-journey-authority';
import { getOrthoCaseStudy } from './ortho-case-study-store';
import { claimStudyExport, failStudyExport, publishStudyExport, type StudyExportLease, type StudyExportRendition } from './ortho-study-export-archive-store';
import type { StudyExportFailure } from './ortho-study-export-archive-contract';
import { studyTextPresentation } from './ortho-study-text-export';
import { renderStudyTextPptx } from './ortho-study-pptx';
import { withIllustratedStudy } from './ortho-study-illustrated-store';
import { fullStudyPresentation } from './ortho-study-full-layout';
import { renderFullStudyPptx } from './ortho-study-full-pptx';
import { storeStudyExportArtifact } from './ortho-study-export-artifact-storage';

const SLOT = 'ortho-study-export-render-v1';
let active = false;
const refused = (code: string, status = 409) => ({ ok: false as const, status, code });
function failureCode(error: unknown): StudyExportFailure {
  const message = error instanceof Error ? error.message : '';
  if (message === 'STUDY_EXPORT_STORAGE_UNAVAILABLE') return 'storage_unavailable';
  if (message === 'STUDY_EXPORT_ARTIFACT_WRITE_FAILED') return 'storage_failed';
  if (/^(?:full_study_|study_).*limit$/.test(message)) return 'render_limit';
  return 'render_failed';
}

/** Explicit authenticated run/retry. No detached promise, stored session or clinical
 * mutation. A process slot plus a dedicated PostgreSQL session advisory lock bound
 * render concurrency across workers; transactions are never held during encoding. */
export async function runStudyExport(input: JourneyOwnerInput & { jobId: number; expectedGeneration: number }) {
  const admission = await getOrthoCaseStudy({ ...input, exportAccess: true });
  if (!admission.ok) return admission;
  if (active) return refused('study_export_busy');
  // A shared local SQL connection cannot own an independent session lock.
  if (usesSharedLocalDatabaseConnection() || Number(process.env.DB_POOL_MAX) === 1) return refused('study_export_runtime_unavailable');
  active = true;
  let client: DbClient | null = null;
  let locked = false, destroy = false, publicationStarted = false, connectionLost = false;
  type SlotClient = DbClient & { on: (event: 'error', listener: () => void) => unknown; removeListener: (event: 'error', listener: () => void) => unknown };
  let slotClient: SlotClient | null = null;
  const onConnectionError = () => { connectionLost = true; destroy = true; };
  let lease: StudyExportLease | null = null;
  try {
    client = await getPool().connect();
    const candidate = client as Partial<SlotClient>;
    if (typeof candidate.on !== 'function' || typeof candidate.removeListener !== 'function') { destroy = true; return refused('study_export_runtime_unavailable'); }
    slotClient = client as SlotClient; slotClient.on('error', onConnectionError);
    locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [SLOT])).rows[0]?.locked === true;
    if (!locked) return refused('study_export_busy');
    const claimed = await claimStudyExport(input);
    if (!claimed.ok) return claimed;
    if (!claimed.lease) return { ok: true as const, job: claimed.job };
    lease = claimed.lease;
    if (!claimed.revision) throw Error('study_export_missing_revision');
    let bytes: Uint8Array, pageCount: number, renditions: StudyExportRendition[] = [];
    if (claimed.job.format === 'text-pptx') {
      const presentation = studyTextPresentation(claimed.revision, claimed.scope);
      bytes = await renderStudyTextPptx(presentation); pageCount = presentation.pages.length;
    } else {
      const revision = claimed.revision;
      const prepared = await withIllustratedStudy({ ...input, revisionId: revision.id }, async verified => {
        const presentation = await fullStudyPresentation(revision, claimed.scope, verified);
        const output = await renderFullStudyPptx(presentation);
        return { bytes: output, pageCount: presentation.pages.length,
          renditions: verified.pages.flatMap(page => page.image ? [{ useId: page.image.use.useId,
            documentId: page.image.use.documentId, sourceSha256: page.image.sourceSha256,
            recipeSha256: page.image.recipeSha256, geometrySha256: page.image.geometrySha256,
            renditionSha256: page.image.renditionSha256, processorVersion: page.image.processorVersion }] : []) };
      });
      if (!prepared.ok) {
        await failStudyExport({ ...input, lease, code: 'authority_changed' });
        return prepared;
      }
      ({ bytes, pageCount, renditions } = prepared.output);
    }
    if (connectionLost) throw Error('study_export_slot_lost');
    const reference = await storeStudyExportArtifact(bytes);
    await client.query('SELECT 1');
    if (connectionLost) throw Error('study_export_slot_lost');
    // From this point a lost database response is uncertain. Retain private bytes
    // and let the durable receipt resolve it; never delete or overwrite on retry.
    publicationStarted = true;
    return await publishStudyExport({ ...input, lease, artifact: { ...reference, pageCount, renditions } });
  } catch (error) {
    if (publicationStarted) return refused('study_export_publication_unconfirmed');
    if (lease) {
      const failure = await failStudyExport({ ...input, lease, code: failureCode(error) }).catch(() => null);
      if (failure?.ok) return { ...refused('study_export_failed'), job: failure.job };
      if (failure && !failure.ok) return failure;
    }
    return refused('study_export_run_unconfirmed');
  } finally {
    try {
      if (client) {
        if (locked && !connectionLost) try {
          const unlocked = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [SLOT]);
          destroy = unlocked.rows[0]?.unlocked !== true;
        } catch { destroy = true; }
        try { client.release(destroy || connectionLost); }
        finally { slotClient?.removeListener('error', onConnectionError); }
      }
    } finally { active = false; }
  }
}
