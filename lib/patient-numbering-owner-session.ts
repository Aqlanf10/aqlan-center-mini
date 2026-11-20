import 'server-only';
import type { PoolClient } from 'pg';
import type { NumberingOwnerSession } from './patient-numbering-command';
import { revalidateBoundRequestSession, type BoundRequestSession } from './session';
import { resolveStaffCapabilities, type TrustedOwnerContext } from './staff-capabilities';
import { classifyStaffPermissionEnvelope } from './staff-permission-envelope';

export type TrustedNumberingOwnerBinding = (client: PoolClient) => Promise<TrustedOwnerContext | null>;

/** Unmounted, request-scoped provider for PatientNumberingPostgresBackend.
 * Lock order is its existing allocator config lock, then trusted binding, user,
 * and optional clinician party. Caller may import no settings or role fallback.
 * The separately governed binding loader must read and lock current protected
 * state on this client. No such production loader is installed here.
 */
export function createNumberingOwnerSessionProvider(
  request: BoundRequestSession | null = null, readTrustedBinding: TrustedNumberingOwnerBinding | null = null,
): (client: PoolClient) => Promise<NumberingOwnerSession | null> {
  return async client => {
    if (!request || !readTrustedBinding) return null;
    const binding = await readTrustedBinding(client);
    if (!binding) return null;
    const current = await revalidateBoundRequestSession(request, client);
    if (!current) return null;
    const { payload, sessionBinding } = current;
    // Canonical session already holds user's SHARE lock. The raw authority
    // projection is separate because findUserByUsername normalizes legacy JSON.
    const { rows } = await client.query<{ permissions: unknown; party_id: number | null }>(
      'SELECT permissions, party_id FROM users WHERE id=$1 FOR SHARE', [payload.userId],
    );
    if (rows.length !== 1 || rows[0].party_id !== payload.partyId) return null;
    const envelope = classifyStaffPermissionEnvelope(rows[0].permissions);
    if (envelope.kind !== 'canonical') return null;
    const id = rows[0].party_id;
    if (id !== null) {
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      const party = await client.query<{ id: number }>(
        "SELECT id FROM parties WHERE id=$1 AND kind='doctor' AND is_active FOR SHARE", [id],
      );
      if (party.rows.length !== 1 || party.rows[0].id !== id) return null;
    }
    if (payload.expiresAt <= Date.now()) return null;
    const access = resolveStaffCapabilities({ subject: {
      userId: payload.userId, role: payload.role, isActive: true, clinicianPartyId: id,
    }, permissionDocument: envelope.value }, binding);
    return access.status === 'allowed' && access.isOwner ? Object.freeze({ access, sessionBinding }) : null;
  };
}
