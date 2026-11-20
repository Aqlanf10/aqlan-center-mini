/** Local shared-writer protection, not owner enrollment or a permission grant. */
import type { SessionPayload } from './auth';
import type { DbClient } from './db';
import { boundOwnerRelationship, type TrustedOwnerContext } from './staff-capabilities';

export type StaffAccountProtection = Readonly<{ mode: 'unconfigured' }> | Readonly<{
  mode: 'protected';
  /** Read/lock currently trusted enrollment using this transaction, never request JSON. */
  readBinding: (client: DbClient) => Promise<TrustedOwnerContext | null>;
}>;
// Intentionally no production binding/credential/setting; invalid protected mode
// does not fall back to this explicit unconfigured choice.
export const STAFF_ACCOUNT_PROTECTION: StaffAccountProtection = Object.freeze({ mode: 'unconfigured' });
export interface StaffAccountWriteContext {
  /** Admitted server-side signed session only; never populate from request JSON. */
  readonly session: SessionPayload;
  /** Trusted server injection only. Omit to use application default. */
  readonly protection?: StaffAccountProtection;
}
export type StaffAccountWriteRefusal = 'owner-protection-unverified' | 'owner-account-protected'
  | 'staff-authority-stale' | 'last-active-admin' | 'invalid-doctor-link';
export class StaffAccountWriteError extends Error {
  constructor(readonly reason: StaffAccountWriteRefusal) { super(reason); this.name='StaffAccountWriteError'; }
}
export const STAFF_ACCOUNT_MUTATION_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('staff-account-mutation-v1',0))";
const idValid = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
export interface LockedStaffMutationTarget { id: number; party_id: number | null; role: string; is_active: boolean }

/** Explicit mode and verified binding. The self-password lane may target its
 * own bound account; it never authorizes another account or accepts a raw hash. */
export async function checkStaffWriteProtection(client: DbClient, targetId: number,
  policy: StaffAccountProtection, hasSession: boolean, selfPassword = false): Promise<void> {
  if (policy.mode === 'unconfigured') return;
  if (policy.mode !== 'protected' || typeof policy.readBinding !== 'function') throw new StaffAccountWriteError('owner-protection-unverified');
  let binding: TrustedOwnerContext | null = null;
  try { binding = await policy.readBinding(client); } catch { throw new StaffAccountWriteError('owner-protection-unverified'); }
  const relation = boundOwnerRelationship(binding, targetId);
  if (relation === null) throw new StaffAccountWriteError('owner-protection-unverified');
  if (!hasSession) throw new StaffAccountWriteError('staff-authority-stale');
  if (relation === 'owner' && !selfPassword) throw new StaffAccountWriteError('owner-account-protected');
}

/** Called before *any* generic update/link work. A consistent final row lock avoids
 * shared-lock upgrades. No owner information, credential, or grants are returned. */
export async function protectStaffAccountWrite(
  client: DbClient, targetId: number, context: StaffAccountWriteContext | undefined,
  revalidate: (session: SessionPayload, client: DbClient) => Promise<SessionPayload | null>,
): Promise<LockedStaffMutationTarget | null> {
  if (!idValid(targetId)) throw new StaffAccountWriteError('staff-authority-stale');
  const policy = context?.protection ?? STAFF_ACCOUNT_PROTECTION;
  const session = context?.session;
  // All shared update/link writers fence last-admin checks, then protected binding,
  // actor/target rows (sorted), then any existing commission party locks.
  await client.query(STAFF_ACCOUNT_MUTATION_LOCK_SQL);
  await checkStaffWriteProtection(client, targetId, policy, Boolean(session));
  if (session && (!idValid(session.userId) || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now() || session.role !== 'admin')) throw new StaffAccountWriteError('staff-authority-stale');
  const ids = [...new Set([targetId, ...(session ? [session.userId] : [])])].sort((a, b) => a - b);
  const { rows } = await client.query<LockedStaffMutationTarget>(
    'SELECT id, party_id, role, is_active FROM users WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE', [ids],
  );
  if (session) {
    if (!rows.some(r=>r.id===session.userId)) throw new StaffAccountWriteError('staff-authority-stale');
    const fresh = await revalidate(session, client);
    if (!fresh || fresh.userId !== session.userId || fresh.role !== 'admin') throw new StaffAccountWriteError('staff-authority-stale');
  }
  return rows.find(r=>r.id===targetId) ?? null;
}
