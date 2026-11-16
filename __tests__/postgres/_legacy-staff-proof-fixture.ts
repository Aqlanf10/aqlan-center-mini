import {
  createSessionToken, legacySessionEvidence, readSessionToken, sessionCredentialVersion,
  type SessionPayload,
} from "../../lib/auth";
import type { LegacyStaffWriteAuthorization } from "../../lib/legacy-staff-boundary";

/** Test-only bootstrap of a real synthetic account, not a writer authorization bypass. */
export async function seedLegacyStaffAdmin(username: string): Promise<SessionPayload> {
  const { getPool } = await import("../../lib/db");
  const passwordHash = "synthetic-legacy-staff-fixture-unused-login-hash";
  const { rows: [user] } = await getPool().query<{ id: number }>(
    "INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES($1,'Synthetic staff fixture administrator',$2,'admin',TRUE) RETURNING id",
    [username, passwordHash],
  );
  return { userId: user.id, username, role: "admin", expiresAt: Date.now() + 3_600_000,
    credentialVersion: sessionCredentialVersion(passwordHash) };
}

/** Obtain opaque evidence only from the actual signature-verifying parser. */
export function signedLegacyStaffProof(session: SessionPayload): LegacyStaffWriteAuthorization {
  const parsed = readSessionToken(createSessionToken(session));
  if (!parsed) throw new Error("Synthetic legacy staff signed session was rejected");
  const evidence = legacySessionEvidence(parsed);
  if (!evidence) throw new Error("Synthetic legacy staff signed evidence is missing");
  return { evidence };
}
