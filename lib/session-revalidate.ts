import {
  sessionCredentialVersion,
  sessionPermissionVersion,
  carryLegacySessionEvidence,
  type SessionPayload,
} from "./auth";
import { financeAccessFor } from "./finance-permissions";
import {
  findUserByUsername,
  findLegacyUserByUsernameReadOnlySnapshot,
  type StaffUser,
  type DbClient,
} from "./db";

export async function currentSession(
  payload: SessionPayload | null,
  client?: DbClient,
): Promise<SessionPayload | null> {
  if (!payload?.credentialVersion) return null;
  const user = client
    ? await findUserByUsername(payload.username, client)
    : await findUserByUsername(payload.username);
  return currentSessionForUser(payload, user);
}

export function currentSessionForUser(
  payload: SessionPayload,
  user: StaffUser | null,
): SessionPayload | null {
  if (payload.expiresAt <= Date.now()) return null;
  if (
    !user ||
    !user.isActive ||
    user.id !== payload.userId ||
    payload.credentialVersion !== sessionCredentialVersion(user.passwordHash)
  ) {
    return null;
  }
  if (payload.role !== user.role) return null;
  if (
    (user.role === "cashier" || user.role === "accountant") &&
    payload.permissionVersion !== sessionPermissionVersion(user.role, user.permissions?.financeAccess)
  ) {
    return null;
  }
  return carryLegacySessionEvidence(payload, {
    ...payload,
    role: user.role,
    partyId: user.partyId,
    financeAccess:
      user.role === "cashier" || user.role === "accountant"
        ? financeAccessFor(user.role, user.permissions?.financeAccess)
        : undefined,
  });
}

export async function revalidateSessionInTransaction(
  payload: SessionPayload,
  client: DbClient,
): Promise<SessionPayload | null> {
  return currentSession(payload, client);
}

export async function revalidateLegacySessionReadOnlySnapshot(
  payload: SessionPayload,
  client: DbClient,
): Promise<SessionPayload | null> {
  if (!payload?.credentialVersion) return null;
  return currentSessionForUser(
    payload,
    await findLegacyUserByUsernameReadOnlySnapshot(payload.username, client),
  );
}
