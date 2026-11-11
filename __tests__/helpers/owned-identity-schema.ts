import { randomBytes } from "node:crypto";
import type { Client } from "pg";

/** Own only a successfully created, identity-matched synthetic schema. */
export async function withOwnedIdentitySchema<T>(db: Pick<Client, "query">, run: (schema: string) => Promise<T>): Promise<T> {
  const schema = `aqlan_identity_${randomBytes(8).toString("hex")}`;
  const identity = async () => (await db.query<{ oid: string; owner: string }>(
    "SELECT oid::text AS oid, nspowner::text AS owner FROM pg_catalog.pg_namespace WHERE nspname=$1", [schema],
  )).rows;
  // A collision or uncertain CREATE never grants ownership and never triggers DROP.
  await db.query(`CREATE SCHEMA ${schema}`);
  const created = await identity();
  if (created.length !== 1) throw new Error("Synthetic identity schema ownership unavailable; cleanup refused.");
  const cleanup = async () => {
    const current = await identity();
    if (current.length !== 1 || current[0].oid !== created[0].oid || current[0].owner !== created[0].owner) {
      throw new Error("Synthetic identity schema identity changed; cleanup refused.");
    }
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
  };
  try {
    return await run(schema);
  } finally {
    await cleanup();
  }
}
