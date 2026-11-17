import type { SessionPayload } from './auth';
import type { DbClient } from './db';
import { revalidateSessionInTransaction } from './session';
export class ClinicalMutationAuthorityError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409, message: string) { super(message); }
}
export async function currentClinicalActor(session: SessionPayload, client: DbClient) {
  if (!session || !Number.isSafeInteger(session.userId) || session.userId <= 0 || typeof session.username !== 'string') {
    throw new ClinicalMutationAuthorityError(401, 'انتهت الجلسة. سجّل الدخول من جديد.');
  }
  const current = await revalidateSessionInTransaction(session, client);
  if (!current || current.userId !== session.userId || current.username !== session.username || current.role !== session.role || current.expiresAt < Date.now()) {
    throw new ClinicalMutationAuthorityError(401, 'انتهت الجلسة أو تغيّرت صلاحياتها.');
  }
  return current;
}
export function assertClinicalActorUnexpired(session: SessionPayload) {
  if (session.expiresAt < Date.now()) throw new ClinicalMutationAuthorityError(401, 'انتهت الجلسة أثناء الحفظ.');
}
