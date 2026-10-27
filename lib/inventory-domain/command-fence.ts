import type { DbClient } from "../db";
import type { InventoryActor } from "./procurement-store";
import type { InventoryPrincipal } from "./principal";
import { invariant } from "./quantities";

export interface InventoryCommandBinding {
  payload_hash: string;
  realm_id: string;
  subject_id: string;
  username: string;
  management: boolean;
  admitted_in_current_transaction: boolean;
}
export async function readInventoryCommandBinding(
  client: DbClient,
  actor: InventoryActor,
  key: string,
  scope: string,
  required = false,
): Promise<InventoryCommandBinding | null> {
  const schema = (
    await client.query<{ bindings: boolean; retirements: boolean }>(
      "SELECT to_regclass('inventory_command_bindings') IS NOT NULL AS bindings,to_regclass('inventory_command_retirements') IS NOT NULL AS retirements",
    )
  ).rows[0];
  invariant(
    schema &&
      schema.bindings === schema.retirements &&
      (!required || schema.bindings),
    "schema_not_ready",
    "Inventory command lifecycle awaits its complete additive proposal",
  );
  if (!schema.bindings) return null;
  return (
    (
      await client.query<InventoryCommandBinding>(
        "SELECT payload_hash,realm_id,subject_id,username,management,(created_xid=pg_current_xact_id()) AS admitted_in_current_transaction FROM inventory_command_bindings WHERE scope=$1 AND actor_id=$2 AND operation_key=$3",
        [scope, actor.userId, key],
      )
    ).rows[0] ?? null
  );
}
export function authorizeInventoryCommandBinding(
  binding: InventoryCommandBinding,
  actor: InventoryActor,
  hash: string,
  management: boolean,
  principal?: InventoryPrincipal,
) {
  invariant(
    principal &&
      principal.actorUserId === actor.userId &&
      principal.username === actor.username &&
      binding.realm_id === principal.realmId &&
      binding.subject_id === principal.subjectId &&
      binding.username === principal.username,
    "command_provenance_required",
    "This command requires its authoritative admitted principal",
  );
  invariant(
    binding.payload_hash === hash,
    "idempotency_conflict",
    "This operation key already identifies different content",
  );
  invariant(
    binding.management === management,
    "command_policy_mismatch",
    "Command admission policy cannot be replaced",
  );
}
