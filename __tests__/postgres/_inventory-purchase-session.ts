import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";

/** Synthetic trusted payload; HTTP-only mocks bypass cookie transport, not the
 * writer's real account, credential, role and permission revalidation. */
export async function purchaseTestSession(username: string, role: string): Promise<SessionPayload> {
  const { getPool } = await import("../../lib/db");
  process.env.SESSION_SECRET = "synthetic-inventory-purchase-session-secret-2026";
  const { rows: [user] } = await getPool().query<{ id: number; password_hash: string }>(
    `INSERT INTO users(username,display_name,password_hash,role,is_active)
     VALUES($1,$1,'synthetic-inventory-hash',$2,true)
     ON CONFLICT(username) DO UPDATE SET role=EXCLUDED.role,is_active=true
     RETURNING id,password_hash`, [username, role]);
  return { userId: user.id, username, role, expiresAt: Date.now() + 3_600_000,
    credentialVersion: sessionCredentialVersion(user.password_hash) };
}
