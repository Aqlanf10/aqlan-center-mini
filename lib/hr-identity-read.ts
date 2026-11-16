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
  let locked=false, began=false, discard=false;
  const fence="aqlan.canonical.identity.substrate.v1:public";
  try {
    // Acquire outside RR: its first snapshot must be taken AFTER any installer
    // wait, never before a blocking transaction-lock SELECT.
    try {
      await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))",[fence]);
      locked=true;
    } catch(error) { discard=true; throw error; }
    began=true;
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
    began=false;
    return preview;
  } catch (error) {
    if(began){try{await client.query('ROLLBACK');began=false;}catch{discard=true;}}
    throw error;
  } finally {
    if(locked){
      try{
        const {rows}=await client.query<{unlocked:boolean}>("SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked",[fence]);
        if(rows.length!==1 || rows[0].unlocked!==true)discard=true;
      }catch{discard=true;}
    }
    // DbClient.release(true) is supported by node-postgres and removes the
    // connection rather than recycling a possibly locked/aborted backend.
    client.release(discard);
  }
}
