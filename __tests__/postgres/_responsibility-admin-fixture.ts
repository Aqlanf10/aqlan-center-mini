import { sessionCredentialVersion, type SessionPayload } from "../../lib/auth";

/** Real persisted active admin and valid credential-version claim; never bypass authorization. */
export async function responsibilityAdminFixture(username: string): Promise<SessionPayload> {
  const { getPool } = await import("../../lib/db");
  const passwordHash = "synthetic-responsibility-unused-login-hash";
  const { rows: [user] } = await getPool().query<{ id: number }>(
    "INSERT INTO users(username,display_name,password_hash,role) VALUES ($1,'Synthetic responsibility administrator',$2,'admin') RETURNING id",
    [username,passwordHash],
  );
  return { userId:user.id, username, role:"admin", partyId:null,
    credentialVersion:sessionCredentialVersion(passwordHash), expiresAt:Date.now()+3_600_000 };
}
