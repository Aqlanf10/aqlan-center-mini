import type { SessionPayload } from './auth';
import type { DbClient } from './db';
import { revalidateSessionInTransaction } from './session';
import { historyFail } from './hr-temporal-request';

const issued = new WeakSet<object>();
export interface HrTemporalAuthority {
  verify(client: DbClient): Promise<SessionPayload>;
  assertCurrent(): void;
}
/** Only call with the signed session admitted by requireSession, never request JSON. */
export function hrTemporalAuthority(admitted: SessionPayload, signal?: AbortSignal): HrTemporalAuthority {
  const session = Object.freeze({ ...admitted });
  const assertCurrent = () => {
    if (signal?.aborted) historyFail('request_cancelled', 'أُلغي الطلب؛ لا توجد نتيجة حفظ مؤكدة. تحقق من السجل قبل تغيير الطلب.', 409);
    if (!Number.isFinite(session.expiresAt) || session.expiresAt < Date.now()) historyFail('session_expired', 'انتهت الجلسة؛ لم تُعتمد الكتابة.', 401);
  };
  const authority: HrTemporalAuthority = Object.freeze({ assertCurrent, verify: async (client: DbClient) => {
    assertCurrent();
    // Canonical current-session check acquires the users SHARE lock before resource locks.
    const live = await revalidateSessionInTransaction(session, client);
    if (!live || live.role !== 'admin' || live.userId !== session.userId || live.username !== session.username) historyFail('authority_changed', 'تغيّرت صلاحية الجلسة؛ السجل للمدير الحالي وحده.', 403);
    assertCurrent(); return live;
  } });
  issued.add(authority); return authority;
}
export function requireHrTemporalAuthority(authority: HrTemporalAuthority): void {
  if (!authority || !issued.has(authority)) historyFail('untrusted_authority', 'لم تُقدّم صلاحية خادم موثوقة.', 403);
}
