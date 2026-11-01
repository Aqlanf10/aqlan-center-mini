import "server-only";
import { revokeLegacySessionIfCurrent } from "./db";
import { readSessionPayload } from "./session";
import { revokeCanonicalStaffSession } from "./staff-session-revocation";
import { selectRequestStaffEnvelope } from "./staff-session-admission";

/**
 * Revokes server-side session state for `POST /api/auth/logout` ONLY if the
 * presented session token (canonical or legacy) is currently valid and unrevoked.
 *
 * Prevents an already-revoked token from bumping `session_version` or
 * `authorization_epoch` and invalidating newer sessions.
 */
export async function performRequestStaffLogout(): Promise<void> {
  try {
    const selected = await selectRequestStaffEnvelope();
    if (selected.kind === "canonical") {
      await revokeCanonicalStaffSession(selected.handle).catch(() => {});
      return;
    }
    if (selected.kind === "denied") {
      return;
    }
    const payload = await readSessionPayload().catch(() => null);
    if (payload?.userId) {
      await revokeLegacySessionIfCurrent(payload).catch(() => {});
    }
  } catch {
    // Logout cookie clearing always succeeds even if the backing DB is unreachable.
  }
}
