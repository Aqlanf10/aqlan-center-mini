import "server-only";
import { PURCHASE_RESET_FENCE } from "../clinic-reset";
import type { SessionPayload } from "../auth";
import type { DbClient } from "../db";
import { revalidateSessionInTransaction } from "../session";
import {
  validStaffIdentity,
  type StaffIdentityClaims,
} from "../staff-authenticated-identity";
import { classifyStaffPermissionEnvelope } from "../staff-permission-envelope";
import { invariant } from "./quantities";
import { requireInventoryIntegration } from "./rollout";
import type { InventoryPrincipal } from "./principal";

/** The payload must originate from signed canonical session authentication, never request JSON. */
export async function authenticateSupplierSession(
  client: DbClient,
  signed: SessionPayload,
) {
  requireInventoryIntegration();
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
    [PURCHASE_RESET_FENCE],
  );
  const session = await revalidateSessionInTransaction(signed, client);
  invariant(
    session,
    "supplier_reauthentication_required",
    "Sign in again to confirm current supplier authority",
  );
  invariant(
    validStaffIdentity(session.authority),
    "supplier_reauthentication_required",
    "Sign in again after authority provisioning",
  );
  const ready = (
    await client.query<{ ready: boolean }>(
      "SELECT to_regclass('staff_authority_identity') IS NOT NULL AND to_regclass('inventory_supplier_intents') IS NOT NULL AND to_regclass('inventory_supplier_intent_rejections') IS NOT NULL AS ready",
    )
  ).rows[0];
  invariant(
    ready?.ready,
    "schema_not_ready",
    "Supplier identity integration is not installed",
  );
  const row = (
    await client.query<{
      realm_id: string;
      execution_epoch_id: string;
      staff_subject_id: string;
      permissions: string | null;
    }>(
      "SELECT a.realm_id,a.execution_epoch_id,u.staff_subject_id,u.permissions FROM staff_authority_identity a CROSS JOIN users u WHERE a.singleton AND u.id=$1 FOR SHARE OF a",
      [session.userId],
    )
  ).rows[0];
  invariant(
    row &&
      row.realm_id === session.authority.realmId &&
      row.execution_epoch_id === session.authority.executionEpochId &&
      row.staff_subject_id === session.authority.subjectId,
    "supplier_reauthentication_required",
    "Authority changed; sign in again and preserve saved commands",
  );
  // Preserve the existing management policy. The future catalogue is not activated here.
  invariant(
    session.role === "admin" &&
      classifyStaffPermissionEnvelope(row.permissions).kind === "legacy",
    "operation_forbidden",
    "Current supplier management authority is required",
  );
  const authority: StaffIdentityClaims = { ...session.authority };
  const principal: InventoryPrincipal = {
    realmId: authority.realmId,
    subjectId: authority.subjectId,
    actorUserId: session.userId,
    username: session.username,
  };
  return { session, authority, principal };
}
