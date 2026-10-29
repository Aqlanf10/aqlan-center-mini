import { createHash } from "node:crypto";
import { STAFF_AUTHORITY_RELATIONS } from "../legacy-staff-schema.mjs";

/**
 * Restore protocol B1 (docs/inventory/CANONICAL-RESTORE-PROTOCOL-20261028.md): the
 * source's identity is not data. The backup records only this lineage line in the
 * manifest: source realm, generation, registry revision and a digest of the excluded
 * authority rows. It is evidence, never authority: nothing in the target is derived
 * from it, and a restore that sees it installs the target-owned hold first (R1).
 */
export interface IdentityProvenance {
  readonly sourceRealm: string | null;
  readonly sourceGeneration: string | null;
  readonly registryRevision: string | null;
  readonly digest: string;
}

interface Query { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

/** Reads inside the caller's snapshot. `null` only when no authority relation exists. */
export async function readIdentityProvenance(source: Query): Promise<IdentityProvenance | null> {
  const { rows: present } = await source.query(
    `SELECT c.relname::text AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
    [[...STAFF_AUTHORITY_RELATIONS]]);
  if (present.length === 0) return null;
  const names = present.map(row => String(row.name));
  const hash = createHash("sha256");
  for (const name of names) {
    const { rows } = await source.query(`SELECT to_jsonb(t)::text AS value FROM "${name}" t ORDER BY to_jsonb(t)::text`);
    hash.update(`${name}\n`);
    for (const row of rows) hash.update(`${String(row.value)}\n`);
  }
  const realm = names.includes("staff_authority_control")
    ? (await source.query("SELECT realm_id::text AS realm FROM staff_authority_control WHERE singleton")).rows[0]?.realm : null;
  const state = names.includes("staff_identity_state")
    ? (await source.query("SELECT generation_id::text AS generation, registry_revision::text AS revision FROM staff_identity_state WHERE singleton")).rows[0] : undefined;
  return Object.freeze({
    sourceRealm: typeof realm === "string" ? realm : null,
    sourceGeneration: typeof state?.generation === "string" ? state.generation : null,
    registryRevision: typeof state?.revision === "string" ? state.revision : null,
    digest: hash.digest("hex"),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Strict manifest shape; `undefined` (absent) is a legacy source. */
export function parseIdentityProvenance(raw: unknown): IdentityProvenance | null | "invalid" {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "digest,registryRevision,sourceGeneration,sourceRealm") return "invalid";
  const uuidOrNull = (field: unknown) => field === null || (typeof field === "string" && UUID.test(field));
  if (!uuidOrNull(value.sourceRealm) || !uuidOrNull(value.sourceGeneration)) return "invalid";
  if (!(value.registryRevision === null || (typeof value.registryRevision === "string" && /^[0-9]{1,19}$/.test(value.registryRevision)))) return "invalid";
  if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest)) return "invalid";
  return Object.freeze({ sourceRealm: value.sourceRealm as string | null, sourceGeneration: value.sourceGeneration as string | null,
    registryRevision: value.registryRevision as string | null, digest: value.digest });
}
