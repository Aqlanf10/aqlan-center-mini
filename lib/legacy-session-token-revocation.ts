import type { DbClient } from "./db";
import { legacySessionTokenHash, type SessionPayload } from "./auth";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";

export const REVOKED_LEGACY_SESSION_SCOPE = "auth.session.revoked";

export function revokedLegacySessionActor(userId: number): string {
  return `user:${userId}`;
}

export async function isLegacyTokenHashRevokedIn(
  source: Pick<DbClient, "query">,
  userId: number,
  tokenHash: string,
  schema = "public",
): Promise<boolean> {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !tokenHash) return false;
  const s = staffIdentitySchemaName(schema);
  const { rows: [reg] } = await source.query<{ oid: string | null }>(
    "SELECT to_regclass($1)::text AS oid",
    [`${s}.http_idempotency_keys`],
  );
  if (!reg?.oid) return false;
  const { rows } = await source.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM ${s}.http_idempotency_keys
      WHERE scope = $1
        AND actor = $2
        AND idempotency_key = $3
      LIMIT 1`,
    [REVOKED_LEGACY_SESSION_SCOPE, revokedLegacySessionActor(userId), tokenHash],
  );
  return rows.length > 0;
}

export async function isLegacyPayloadRevoked(
  payload: SessionPayload,
  userId: number,
  client?: DbClient,
  schema = "public",
): Promise<boolean> {
  const tokenHash = legacySessionTokenHash(payload);
  if (!tokenHash) return false;
  if (client && typeof client.query === "function") {
    return isLegacyTokenHashRevokedIn(client, userId, tokenHash, schema);
  }
  if (!process.env.DATABASE_URL?.trim() || process.env.USE_LOCAL_DB === "true") {
    return false;
  }
  let getPoolFn: (() => Pick<DbClient, "query">) | null = null;
  try {
    const dbMod = await import("./db");
    if (typeof dbMod.getPool === "function") {
      getPoolFn = dbMod.getPool;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("[vitest]")) {
      return false;
    }
    throw error;
  }
  if (!getPoolFn) return false;
  return isLegacyTokenHashRevokedIn(getPoolFn(), userId, tokenHash, schema);
}
