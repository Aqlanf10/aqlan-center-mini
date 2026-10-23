import { parseFollowupCommand, type FollowupCommand } from './appointment-followup-contract';

export const FOLLOWUP_ATTEMPT_CHANGED = 'appointment-followup-attempt-changed';
export function followupAttemptKey(actorId: number, patientId: number, appointmentId: number): string {
  return `appointment-followup:v1:${actorId}:${patientId}:${appointmentId}`;
}
export function readFollowupAttempt(storage: Pick<Storage, 'getItem'>, key: string, patientId: number, appointmentId: number) {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let command: FollowupCommand | null = null;
  try { command = parseFollowupCommand(JSON.parse(raw)); } catch { /* Fail closed; never erase malformed evidence. */ }
  if (!command || command.expectedPatientId !== patientId || command.appointmentId !== appointmentId) {
    throw new Error('طلب محفوظ غير صالح. يلزم مراجعته قبل أي إجراء جديد.');
  }
  return { raw, command };
}
/** Must be called under the per-source Web Lock, after a matching success receipt.
 * Exact comparison also protects evidence written by another/older application. */
export function removeOwnedFollowupAttempt(storage: Pick<Storage, 'getItem' | 'removeItem'>, key: string, raw: string): boolean {
  if (storage.getItem(key) !== raw) return false;
  storage.removeItem(key);
  return true;
}
/** An origin-wide exclusive Web Lock is the authority for read/write/send/ack.
 * No localStorage spinlock or unlocked fallback: those are not atomic across tabs. */
export async function withFollowupAttemptLock(key: string, work: () => Promise<void>): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    throw new Error('هذا المتصفح لا يدعم حماية المحاولة بين التبويبات. استخدم متصفحاً يدعم Web Locks عبر اتصال آمن؛ لم يُرسل أي طلب.');
  }
  return navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) return false;
    await work();
    return true;
  });
}
export function notifyFollowupAttemptChanged(key: string): void {
  window.dispatchEvent(new CustomEvent(FOLLOWUP_ATTEMPT_CHANGED, { detail: key }));
}
