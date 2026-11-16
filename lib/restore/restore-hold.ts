import { readStaffEntryMode, staffLifecycleLockKey } from "../legacy-staff-schema.mjs";

/**
 * Restore protocol R1 (docs/inventory/CANONICAL-RESTORE-PROTOCOL-20261028.md, revision 3):
 * the target-owned durable hold, committed before any schema or data is replayed.
 *
 * - The hold relation is an authority footprint (lib/legacy-staff-schema.mjs), so the
 *   target selects canonical entry from its first committed object: the legacy login,
 *   legacy cookies and legacy writers refuse, and canonical entry needs a ready identity
 *   the target does not have (maintenance).
 * - UPDATE and TRUNCATE always refuse. DELETE is allowed only once THIS target's own
 *   identity is sealed `ready` (durable state guarded by the runtime schema). The guard
 *   never reads a session or transaction setting: neither the application nor the replay
 *   connection can grant itself the release.
 * - Deployment gate (M5): the hold is installed by the restore operator role. The
 *   application and replay roles must not own it (DROP, ALTER and trigger changes need
 *   ownership; `session_replication_role` needs superuser). Arbitrary owner or superuser
 *   SQL is outside any application proof (OWNER_READINESS_AND_ISSUANCE §4).
 * Schema proposal only; the migration number is assigned in M4 (never 0087).
 */
export const RESTORE_HOLD_SQL = `
CREATE TABLE staff_restore_hold (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  hold_id UUID NOT NULL,
  source_manifest_digest TEXT NOT NULL CHECK (source_manifest_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  state TEXT NOT NULL DEFAULT 'held' CHECK (state = 'held')
);
CREATE FUNCTION staff_restore_hold_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  state_relation regclass;
  sealed boolean := false;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'restore hold cannot be truncated'; END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'restore hold is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN
    -- The identity state of THIS table's schema only (never the caller's search_path).
    state_relation := to_regclass(format('%I.staff_identity_state', TG_TABLE_SCHEMA));
    IF state_relation IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE singleton AND status = %L)', state_relation, 'ready') INTO sealed;
    END IF;
    IF NOT sealed THEN
      RAISE EXCEPTION 'restore hold is released only by the reviewed seal of this target';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_restore_hold_guard_row BEFORE INSERT OR UPDATE OR DELETE ON staff_restore_hold
  FOR EACH ROW EXECUTE FUNCTION staff_restore_hold_guard();
CREATE TRIGGER staff_restore_hold_no_truncate BEFORE TRUNCATE ON staff_restore_hold
  FOR EACH STATEMENT EXECUTE FUNCTION staff_restore_hold_guard();
`;

interface Client { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }
export type RestoreHoldRefusal = "restore_target_not_empty" | "restore_target_has_identity";
export class RestoreHoldError extends Error {
  constructor(readonly code: RestoreHoldRefusal) { super(code); }
}

/**
 * Lock order (revision 3 §R2): the lifecycle fence EXCLUSIVE first, as every authority
 * writer (OWNER_READINESS §4). It waits for every admitted canonical operation, issuer
 * and reader, and every legacy staff writer, on this target. Then, in the same
 * transaction, the target must have no base table and no authority footprint: a target
 * that was ever ready, quarantined or bootstrapped is refused before anything is written.
 */
export async function installRestoreHold(client: Client, input: { holdId: string; manifestDigest: string }): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [staffLifecycleLockKey("public")]);
    if (await readStaffEntryMode(client, "public") !== "legacy") throw new RestoreHoldError("restore_target_has_identity");
    const { rows: [count] } = await client.query(
      "SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
    if (Number(count?.tables) !== 0) throw new RestoreHoldError("restore_target_not_empty");
    await client.query(RESTORE_HOLD_SQL);
    await client.query("INSERT INTO staff_restore_hold (hold_id, source_manifest_digest) VALUES ($1, $2)", [input.holdId, input.manifestDigest]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
