import type { PoolClient } from "pg";
export interface ExpectedManagedNumberingGeneration { schema: string; lineage: string; generation: string }
export function validManagedNumberingGeneration(value: ExpectedManagedNumberingGeneration | null | undefined): value is ExpectedManagedNumberingGeneration {
  return !!value && typeof value.schema === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(value.schema)
    && typeof value.lineage === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.lineage)
    && typeof value.generation === "string" && /^[1-9][0-9]{0,18}$/.test(value.generation)
    && BigInt(value.generation) <= 9223372036854775807n;
}
export async function lockManagedNumberingGeneration(client: PoolClient, value: ExpectedManagedNumberingGeneration): Promise<string> {
  if (!validManagedNumberingGeneration(value)) throw new Error("Managed generation not configured");
  const { schema, lineage, generation } = value;
  // The exact expected epoch is supplied from a trusted operational source.
  // Claiming an XID/phase or reading archive data cannot take this lock.
  const { rows } = await client.query(
    `/* numbering-bound-settings-admission */ SELECT version,lineage::text,phase,generation::text
      FROM ${schema}.generation_state WHERE id=1 FOR SHARE`,
  );
  const state = rows[0];
  if (rows.length !== 1 || state.version !== 1 || state.lineage !== lineage
    || state.phase !== "MANAGED" || state.generation !== generation) throw new Error("Managed writer proof unavailable");
  const { rows: [transaction] } = await client.query("SELECT pg_current_xact_id_if_assigned()::text AS xid");
  if (typeof transaction?.xid !== "string" || !/^[1-9][0-9]*$/.test(transaction.xid)) throw new Error("Managed writer requires a held transaction");
  return transaction.xid;
}
