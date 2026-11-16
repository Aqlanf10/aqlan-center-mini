import { randomUUID } from "node:crypto";

// Shared by the application and the plain Node restore CLI. No schema creation,
// environment access, connection acquisition or permission grant belongs here.
const boundHistory = [
  "inventory_command_bindings",
  "supplier_invoice_finance_roots",
  "inventory_supplier_intents",
  "inventory_supplier_intent_rejections",
];

function refuse(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function transaction(client) {
  await client.query("SAVEPOINT staff_authority_lifecycle_probe");
  await client.query("RELEASE SAVEPOINT staff_authority_lifecycle_probe");
}

function validateReason(reason) {
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 2000)
    refuse("invalid_staff_authority_reason");
}

async function schemaPresent(client) {
  const { rows: [row] } = await client.query(`SELECT
    to_regclass('public.staff_authority_identity') IS NOT NULL AS identity,
    to_regclass('public.staff_execution_epochs') IS NOT NULL AS epochs,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='users' AND column_name='staff_subject_id') AS subjects`);
  const parts = [row.identity, row.epochs, row.subjects];
  if (parts.every(value => !value)) return false;
  if (!parts.every(Boolean)) refuse("partial_staff_authority_schema");
  return true;
}

async function presentBoundTables(client) {
  const { rows } = await client.query(
    "SELECT name FROM unnest($1::text[]) name WHERE to_regclass('public.' || name) IS NOT NULL",
    [boundHistory],
  );
  return rows.map(row => row.name);
}

async function assertNoUnanchoredHistory(client) {
  if ((await client.query("SELECT 1 FROM staff_execution_epochs LIMIT 1")).rowCount)
    refuse("staff_authority_history_without_identity");
  for (const table of await presentBoundTables(client)) {
    // Identifiers originate only from the fixed internal list above.
    if ((await client.query(`SELECT 1 FROM "${table}" LIMIT 1`)).rowCount)
      refuse("bound_history_without_staff_authority");
  }
}

async function validateHistoricalRealm(client, realmId) {
  for (const table of await presentBoundTables(client)) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM "${table}" WHERE realm_id::text <> $1 LIMIT 1`, [realmId],
    );
    if (rowCount) refuse("restored_staff_realm_mismatch");
    if (table !== "supplier_invoice_finance_roots") {
      const { rowCount: wrongSubject } = await client.query(
        `SELECT 1 FROM "${table}" b LEFT JOIN users u ON u.id=b.actor_id
          WHERE u.id IS NULL OR b.subject_id::text <> u.staff_subject_id::text LIMIT 1`,
      );
      if (wrongSubject) refuse("restored_staff_subject_mismatch");
    }
  }
}

/** Explicit bootstrap only; ordinary reads and token issuance never call it. */
export async function bootstrapStaffIdentityInTransaction(client, reason) {
  await transaction(client);
  validateReason(reason);
  if (!await schemaPresent(client)) refuse("staff_authority_schema_missing");
  await client.query("LOCK TABLE staff_authority_identity IN EXCLUSIVE MODE");
  const { rows: [existing] } = await client.query(
    "SELECT realm_id, execution_epoch_id FROM staff_authority_identity WHERE singleton",
  );
  if (existing) return { realmId: existing.realm_id, executionEpochId: existing.execution_epoch_id };
  await assertNoUnanchoredHistory(client);
  const realmId = randomUUID(), executionEpochId = randomUUID();
  await client.query("INSERT INTO staff_execution_epochs(id,reason) VALUES($1,$2)", [executionEpochId, reason]);
  await client.query(
    "INSERT INTO staff_authority_identity(singleton,realm_id,execution_epoch_id) VALUES(TRUE,$1,$2)",
    [realmId, executionEpochId],
  );
  return { realmId, executionEpochId };
}

/** Caller owns the maintenance transaction and excludes concurrent inventory writes. */
export async function rotateStaffExecutionEpochInTransaction(client, reason) {
  await transaction(client);
  validateReason(reason);
  if (!await schemaPresent(client)) refuse("staff_authority_schema_missing");
  const { rows: [current] } = await client.query(
    "SELECT realm_id FROM staff_authority_identity WHERE singleton FOR UPDATE",
  );
  if (!current) refuse("staff_authority_not_initialized");
  const executionEpochId = randomUUID();
  await client.query("INSERT INTO staff_execution_epochs(id,reason) VALUES($1,$2)", [executionEpochId, reason]);
  await client.query("UPDATE staff_authority_identity SET execution_epoch_id=$1 WHERE singleton", [executionEpochId]);
  return { realmId: current.realm_id, executionEpochId };
}

/** After validated archive INSERTs, before constraints/COMMIT or opening traffic. */
export async function finalizeRestoredStaffIdentityInTransaction(client) {
  await transaction(client);
  if (!await schemaPresent(client)) return null; // Older registered schema stays compatible.
  const identity = await bootstrapStaffIdentityInTransaction(client, "Initialize identity for managed restore");
  await validateHistoricalRealm(client, identity.realmId);
  return rotateStaffExecutionEpochInTransaction(client, "Fence commands after managed restore");
}

/** Reset retains realm and users; refused/rolled-back reset cannot rotate an epoch. */
export async function rotateResetStaffIdentityInTransaction(client) {
  await transaction(client);
  if (!await schemaPresent(client)) return null;
  const { rows: [identity] } = await client.query("SELECT realm_id FROM staff_authority_identity WHERE singleton");
  if (!identity) {
    await assertNoUnanchoredHistory(client);
    return null; // Do not implicitly initialize a previously unused authority.
  }
  return rotateStaffExecutionEpochInTransaction(client, "Fence commands after clinic reset");
}
