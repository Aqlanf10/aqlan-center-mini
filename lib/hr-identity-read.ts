import type { DbPool } from './db';
import type { SessionPayload } from './auth';
import { buildIdentityPreview, IdentityPreviewError, parseIdentityPreviewRequest } from './hr-identity-preview';
import { authorizeIdentityAdmin, readHrIdentitySources } from './hr-identity-sources';
/** The caller supplies a verified signed session, never a session from request JSON.
 * Authentication and evidence use the same READ ONLY snapshot. No schema/bootstrap,
 * audit writer, commission resolver, row lock or sequence allocation is invoked. */
export async function readHrIdentityPreview(pool: Pick<DbPool, 'connect'>, session: SessionPayload | null, request?: unknown) {
  if (!session?.credentialVersion || session.expiresAt <= Date.now()) throw new IdentityPreviewError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await authorizeIdentityAdmin(client, session);
    const sources = await readHrIdentitySources(client);
    let preview = buildIdentityPreview(sources);
    if (request !== undefined) {
      const parsed = parseIdentityPreviewRequest(request);
      if (parsed.sourceDigest !== preview.sourceDigest) throw new IdentityPreviewError(409, 'تغيّرت المصادر؛ حدّث المعاينة وراجع المعرفات مجددًا.');
      preview = buildIdentityPreview(sources, parsed.decisions);
    }
    if (session.expiresAt <= Date.now()) throw new IdentityPreviewError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
    await client.query('COMMIT');
    return preview;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
