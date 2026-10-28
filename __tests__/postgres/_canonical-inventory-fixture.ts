/** Synthetic trusted-ready CANONICAL inventory database (M3a) — test evidence ONLY.
 *
 * One owned PostgreSQL database per suite (never the shared test database):
 *  1. marker-free clinic schema through the real `ensureSchema`;
 *  2. the unpublished inventory proposals (procurement, custody, supplier finance,
 *     supplier number, command lifecycle);
 *  3. the canonical identity substrate (frozen 0076 + substrate + runtime v2), every
 *     account bound to a fresh subject, a direct-SQL ready state (NOT a preparation
 *     service: OWNER_READINESS_AND_ISSUANCE.md §2/§7);
 *  4. the supplier transport proposal, whose intents reference canonical
 *     generations/subjects.
 * Sessions are test-signed durable claims read from the current rows; the runtime then
 * proves them exactly like a real issued token. No owner provenance is implied. */
import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { Pool } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { syntheticClaims, syntheticSign, capabilityDocument } from "./_canonical-ready-fixture";
import { staffIdentitySubstrateSql } from "../../lib/staff-identity-substrate-schema.mjs";
import { initializeStaffIdentitySubstrate, bindStaffAccountIncarnation } from "../../lib/staff-identity-substrate.mjs";
import { staffRuntimeSchemaSql } from "../../lib/staff-runtime-schema.mjs";
import { readVerifiedDurableSession, type VerifiedDurableSession } from "../../lib/staff-durable-session";
import { INVENTORY_PROCUREMENT_SQL } from "../../lib/inventory-domain/schema-proposal";
import { INVENTORY_CUSTODY_SQL } from "../../lib/inventory-domain/custody-schema-proposal";
import { INVENTORY_SUPPLIER_FINANCE_SQL } from "../../lib/inventory-domain/supplier-finance-schema-proposal";
import { INVENTORY_SUPPLIER_NUMBER_SQL } from "../../lib/inventory-domain/supplier-number-schema-proposal";
import { INVENTORY_COMMAND_LIFECYCLE_SQL } from "../../lib/inventory-domain/command-lifecycle-schema-proposal";
import { INVENTORY_SUPPLIER_TRANSPORT_SQL } from "../../lib/inventory-domain/supplier-transport-schema-proposal";

export interface CanonicalInventoryAccount {
  readonly username: string;
  readonly role: string;
  readonly grants?: Record<string, boolean>;
  /** Record scopes of the capability document (default `none`). */
  readonly patientScope?: "none" | "own" | "all";
  readonly appointmentScope?: "none" | "own" | "all";
  /** Link to a synthetic active doctor party (created on demand). */
  readonly doctor?: boolean;
}
export interface CanonicalInventoryDatabase<K extends string> {
  readonly pool: Pool;
  readonly ids: Readonly<Record<K, number>>;
  readonly parties: Readonly<Partial<Record<K, number>>>;
  readonly ownerKey: K;
  /** A fresh signed durable session from the account's CURRENT rows. */
  session(key: K, expiresInMs?: number): Promise<VerifiedDurableSession>;
  /** Replace the account's grants (new permission revision): an authority write. */
  setGrants(key: K, grants: Record<string, boolean>, scopes?: { patientScope?: "none" | "own" | "all"; appointmentScope?: "none" | "own" | "all" }): Promise<void>;
  close(): Promise<void>;
}

/** `db` is the dynamically imported `lib/db` module of the calling suite (after its mocks). */
export async function openCanonicalInventoryDatabase<K extends string>(
  db: typeof import("../../lib/db"),
  accounts: Readonly<Record<K, CanonicalInventoryAccount>>,
  ownerKey: NoInfer<K>,
): Promise<CanonicalInventoryDatabase<K>> {
  const owned = await openBackupTimestampFixture({ ...process.env });
  vi.stubEnv("DATABASE_URL", owned.source.options.connectionString!);
  vi.stubEnv("SKIP_SEED", "true");
  vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
  await db.resetPoolForTesting();
  await db.ensureSchema();
  const pool = owned.source;
  for (const sql of [INVENTORY_PROCUREMENT_SQL, INVENTORY_CUSTODY_SQL, INVENTORY_SUPPLIER_FINANCE_SQL, INVENTORY_SUPPLIER_NUMBER_SQL, INVENTORY_COMMAND_LIFECYCLE_SQL]) await pool.query(sql);
  const ids = {} as Record<K, number>, parties = {} as Partial<Record<K, number>>;
  for (const [key, account] of Object.entries(accounts) as [K, CanonicalInventoryAccount][]) {
    let party: number | null = null;
    if (account.doctor) {
      party = (await pool.query<{ id: number }>("INSERT INTO parties(name,kind,is_active) VALUES($1,'doctor',TRUE) RETURNING id", [`SYN ${account.username}`])).rows[0].id;
      parties[key] = party;
    }
    ids[key] = (await pool.query<{ id: number }>(
      "INSERT INTO users(username,display_name,password_hash,role,is_active,party_id,permissions) VALUES($1,$1,'synthetic-canonical-hash',$2,TRUE,$3,$4) RETURNING id",
      [account.username, account.role, party, JSON.stringify(capabilityDocument({ grants: account.grants ?? {}, patientScope: account.patientScope, appointmentScope: account.appointmentScope }))])).rows[0].id;
  }
  // Any pre-existing account receives an explicit empty canonical document.
  await pool.query("UPDATE users SET permissions=$1 WHERE id<>ALL($2::int[])", [JSON.stringify(capabilityDocument({})), Object.values(ids)]);
  const c = await pool.connect();
  try {
    await c.query(readFileSync(new URL("../fixtures/staff-identity/frozen-0076.sql", import.meta.url), "utf8"));
    await c.query(staffIdentitySubstrateSql("public"));
    await c.query("BEGIN");
    let h = await initializeStaffIdentitySubstrate(c, "public");
    for (const { id } of (await c.query<{ id: number }>("SELECT id FROM users ORDER BY id")).rows)
      h = await bindStaffAccountIncarnation(c, { userId: id, currentSubjectId: null, expected: { generationId: h.generationId, registryRevision: h.registryRevision } }, "public");
    await c.query("COMMIT");
    await c.query(staffRuntimeSchemaSql("public"));
    await c.query("BEGIN");
    await c.query("UPDATE users SET authorization_mode='canonical'");
    await c.query("UPDATE staff_authority_control SET state='prepared',pending_owner_user_id=$1,conversion_digest=repeat('a',64),recovery_reference='synthetic-inventory-fixture-not-bootstrap' WHERE singleton", [ids[ownerKey]]);
    await c.query("UPDATE staff_authority_control SET state='active',owner_user_id=$1,pending_owner_user_id=NULL WHERE singleton", [ids[ownerKey]]);
    await c.query("COMMIT");
    await c.query("UPDATE staff_identity_state SET status='ready',ready_owner_subject_id=(SELECT subject_id FROM staff_identity_current WHERE user_id=$1),ready_control_epoch=(SELECT binding_epoch FROM staff_authority_control) WHERE singleton", [ids[ownerKey]]);
    await c.query(INVENTORY_SUPPLIER_TRANSPORT_SQL);
  } finally { c.release(); }
  const revisions: Partial<Record<K, number>> = {};
  return {
    pool, ids, parties, ownerKey,
    async session(key, expiresInMs = 600_000) {
      const handle = readVerifiedDurableSession(syntheticSign(await syntheticClaims(pool, "public", ids[key], expiresInMs)));
      if (!handle) throw new Error("synthetic canonical token rejected by the durable parser");
      return handle;
    },
    async setGrants(key, grants, scopes = {}) {
      // Monotonic per account even after a test stored a malformed document.
      const { rows: [row] } = await pool.query<{ permissions: string }>("SELECT permissions FROM users WHERE id=$1", [ids[key]]);
      let stored = 0;
      try { const parsed = JSON.parse(row.permissions) as { revision?: unknown }; if (Number.isSafeInteger(parsed.revision)) stored = parsed.revision as number; } catch { /* malformed */ }
      const revision = Math.max(stored, revisions[key] ?? 1) + 1;
      revisions[key] = revision;
      await pool.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants, ...scopes }, revision)), ids[key]]);
    },
    async close() { await db.resetPoolForTesting(); vi.unstubAllEnvs(); await owned.close(); },
  };
}
