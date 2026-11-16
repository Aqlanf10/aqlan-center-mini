import {
  validateReferenceInput,
  referenceText as text,
  referenceInteger as integer,
} from "./reference-validation";
import "server-only";
import { createHash } from "node:crypto";
import type { DbClient, DbPool } from "../db";
import { staffIdentitySchemaName } from "../staff-identity-substrate-schema.mjs";
import type { VerifiedDurableSession } from "../staff-durable-session";
import { staffOperationIdentity, staffOperationReferenceCapabilities, withStaffOperation } from "../staff-operation-runtime";
import { PURCHASE_RESET_FENCE } from "../clinic-reset";
import {
  REFERENCE_PROTOCOL,
  type ReferenceAction,
  type ReferenceAuthority,
  type ReferenceInput,
  type ReferenceIntent,
  type ReferenceRead,
  type ReferenceReply,
  type ReferenceResult,
} from "../inventory-reference-protocol";
import { createInventoryCommandLifecycle, runCanonicalInventoryItemCreateLifecycle,
  snapshotCanonicalItemCreateIntent, validateCanonicalItemCreateMode,
  runCanonicalInventoryUnitReviseLifecycle, runCanonicalInventoryLocationCreateLifecycle,
  snapshotCanonicalUnitReviseIntent, snapshotCanonicalLocationCreateIntent,
  runCanonicalInventoryPolicyReviseLifecycle, snapshotCanonicalPolicyReviseIntent,
  type CanonicalUnitReviseMode, type CanonicalLocationCreateMode,
  type CanonicalItemCreateMode } from "./command-lifecycle";
import {
  INVENTORY_CLINIC_SCOPE,
  writeInventoryAudit,
  type InventoryActor,
} from "./procurement-store";
import {
  resolveInventoryPrincipal,
  type InventoryPrincipal,
} from "./principal";
import { payloadIdentity } from "./procurement";
import {
  invariant,
  quantityAtoms,
  quantityText,
  unitConversionSnapshot,
} from "./quantities";
import { requireInventoryIntegration } from "./rollout";
import { readFirstUseReadinessFacts } from "./first-use-readiness";
import { runCanonicalReadSnapshot } from "../canonical-read-snapshot";

export interface ReferenceSetupContext {
  actor: InventoryActor;
  principal: InventoryPrincipal;
  generation: string;
  allowedActions: readonly ReferenceAction[];
}
/** Central authority owns opaque session authenticity, live permission locks,
 * subject continuity and restore lineage. No role or numeric-ID inference here.
 * The existing inventory journal additionally restricts management to admin;
 * delegated non-admin setup needs a separately reviewed central-helper adaptation. */
export interface ReferenceSetupAuthority<Session> {
  revalidateInTransaction(
    client: DbClient,
    session: Session,
    action: ReferenceAction | "read" | "readiness.read",
  ): Promise<ReferenceSetupContext>;
  verifyHistoricalBindingInTransaction(
    client: DbClient,
    session: Session,
    original: ReferenceIntent,
    current: ReferenceSetupContext,
  ): Promise<void>;
}
const closed: ReferenceSetupAuthority<unknown> = {
  async revalidateInTransaction() {
    throw new Error("inventory_reference_authority_unavailable");
  },
  async verifyHistoricalBindingInTransaction() {
    throw new Error("inventory_reference_authority_unavailable");
  },
};
function immutableIntent(value: ReferenceIntent): ReferenceIntent {
  const copy = JSON.parse(
    payloadIdentity(value).slice("inventory-json-v1:".length),
  ) as ReferenceIntent;
  invariant(
    copy.protocol === REFERENCE_PROTOCOL &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        copy.nonce,
      ),
    "invalid_document",
    "Invalid setup intent",
  );
  text(copy.authority?.realmId, 240, "realm");
  text(copy.authority?.subjectId, 240, "subject");
  text(copy.authority?.generation, 240, "generation");
  validateReferenceInput(copy.input);
  Object.freeze(copy.authority);
  Object.freeze(copy.input);
  return Object.freeze(copy);
}
const authority = (context: ReferenceSetupContext): ReferenceAuthority => ({
  realmId: context.principal.realmId,
  subjectId: context.principal.subjectId,
  generation: context.generation,
});

/** No schema provisioning or connection ownership. Every method requires an
 * explicit transaction; admission must commit before execution. */
export function createReferenceSetupService<Session = unknown>(
  dependencies: ReferenceSetupAuthority<Session> = closed as ReferenceSetupAuthority<Session>,
) {
  async function context(
    client: DbClient,
    session: Session,
    action: ReferenceAction | "read",
  ) {
    requireInventoryIntegration();
    await client.query("SAVEPOINT reference_setup_transaction");
    await client.query("RELEASE SAVEPOINT reference_setup_transaction");
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
      [PURCHASE_RESET_FENCE],
    );
    const value = await dependencies.revalidateInTransaction(
      client,
      session,
      action,
    );
    const principal = await resolveInventoryPrincipal(
      { resolvePrincipal: async () => value.principal },
      value.actor,
    );
    text(value.generation, 240, "current execution generation");
    invariant(
      value.actor.role === "admin",
      "operation_forbidden",
      "Current journal management restriction requires administrator authority in addition to central permission",
    );
    invariant(
      action === "read" || value.allowedActions.includes(action),
      "operation_forbidden",
      "Current central permission does not authorize this setup action",
    );
    const ready = await client.query<{ ready: boolean }>(
      "SELECT to_regclass('inventory_item_unit_versions') IS NOT NULL AND to_regclass('inventory_locations') IS NOT NULL AND to_regclass('inventory_approval_policies') IS NOT NULL AND to_regclass('inventory_command_bindings') IS NOT NULL AND to_regclass('inventory_command_retirements') IS NOT NULL AS ready",
    );
    invariant(
      ready.rows[0]?.ready,
      "schema_not_ready",
      "Reference setup schema is not installed",
    );
    return { ...value, principal };
  }
  async function command(
    client: DbClient,
    session: Session,
    raw: ReferenceIntent,
    mode: "admit" | "execute" | "lookup" | "retire",
    reason?: string,
  ): Promise<ReferenceReply> {
    const intent = immutableIntent(raw);
    const current = await context(client, session, intent.input.action);
    invariant(
      intent.authority.realmId === current.principal.realmId &&
        intent.authority.subjectId === current.principal.subjectId,
      "reference_identity_mismatch",
      "Saved setup identity must not be rewritten or adopted",
    );
    const key = `reference:${createHash("sha256")
      .update(
        JSON.stringify([
          intent.authority.realmId,
          intent.authority.subjectId,
          intent.nonce,
        ]),
      )
      .digest("hex")}`;
    const lifecycle = createInventoryCommandLifecycle(
      { scope: "reference.setup", management: true },
      { resolvePrincipal: async () => current.principal },
    );
    if (intent.authority.generation !== current.generation) {
      await dependencies.verifyHistoricalBindingInTransaction(
        client,
        session,
        intent,
        current,
      );
      // Lookup takes the same command lock before absence can be interpreted.
      // An old pending command stays held, including explicit retirement requests.
      const historical = await lifecycle.lookup(
        client,
        current.actor,
        key,
        intent,
      );
      invariant(
        historical.status !== "pending",
        "reference_generation_mismatch",
        "The original execution generation is no longer current; preserve this pending command",
      );
      return { ...historical, intent } as ReferenceReply;
    }
    const result =
      mode === "admit"
        ? await lifecycle.admit(client, current.actor, key, intent)
        : mode === "lookup"
          ? await lifecycle.lookup(client, current.actor, key, intent)
          : mode === "retire"
            ? await lifecycle.retire(
                client,
                current.actor,
                key,
                intent,
                reason ?? "",
              )
            : await lifecycle.execute(
                client,
                current.actor,
                key,
                intent,
                (c, saved) => write(c, current.actor, saved.input),
              );
    return { ...result, intent } as ReferenceReply;
  }
  return {
    command,
    async read(
      client: DbClient,
      session: Session,
      query = "",
      page = 0,
    ): Promise<ReferenceRead> {
      text(query, 120, "search", true);
      integer(page, 0, 5000);
      const current = await context(client, session, "read");
      return readReferenceFacts(client, authority(current), current.allowedActions, query, page);
    },
  };
}

/** Canonical read-only binding; intentionally not installed in any HTTP transport.
 * Owns READ COMMITTED. Central lifecycle/user/provider locks always precede reset.
 * No caller projection, role label or legacy setup authority can admit this reader. */
export async function readCanonicalInventoryReferences(
  pool: DbPool, session: VerifiedDurableSession, query = "", page = 0, schema = "public",
): Promise<ReferenceRead> {
  requireInventoryIntegration();
  text(query, 120, "search", true);
  integer(page, 0, 5000);
  const referenceSchema = staffIdentitySchemaName(schema);
  return withStaffOperation(pool, session, "inventory.references.view", async (client, handle) => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [PURCHASE_RESET_FENCE]);
    // A reset-fence wait may outlive a session: fresh exact-handle proof BEFORE facts.
    const identity = await staffOperationIdentity(client, handle, "inventory.references.view", referenceSchema);
    const ready = await client.query<{ ready: boolean }>(
      "SELECT bool_and(to_regclass($1 || '.' || name) IS NOT NULL) AS ready FROM unnest($2::text[]) AS name",
      [referenceSchema, ["inventory_items", "inventory_item_unit_versions", "inventory_locations", "inventory_approval_policies", "parties"]],
    );
    invariant(ready.rows[0]?.ready, "schema_not_ready", "Reference read schema is not installed");
    const preview = await staffOperationReferenceCapabilities(client, handle, referenceSchema);
    const allowedActions: ReferenceAction[] = [];
    if (preview.includes("inventory.items.create")) allowedActions.push("item.create");
    if (preview.includes("inventory.units.revise")) allowedActions.push("unit.revise");
    if (preview.includes("inventory.locations.create")) allowedActions.push("location.create");
    if (preview.includes("inventory.approval-policy.manage")) allowedActions.push("policy.revise");
    return readReferenceFacts(client, Object.freeze({realmId: identity.realmId, subjectId: identity.subjectId, generation: identity.generationId}), allowedActions, query, page, referenceSchema);
  }, schema);
}

/** Canonical count-only first-use readiness in one owning RR READ ONLY snapshot,
 * admitted by `inventory.references.view`. Observation grants no later mutation. */
export async function readCanonicalFirstUseReadiness(session: VerifiedDurableSession) {
  requireInventoryIntegration();
  return runCanonicalReadSnapshot(session, "inventory.references.view", client => readFirstUseReadinessFacts(client),
    {errorPrefix: "STAFF_READ", maxBytes: 64 * 1024});
}

/** Server-only command seam (the canonical procurement route composes it per exact action). Gate and copy
 * before acquiring a pool connection; each admission/execution is its own commit.
 * Original authority/generation/envelope remain unmodified in all modes. */
export async function commandCanonicalInventoryItemCreate(
  pool: DbPool, session: VerifiedDurableSession, original: ReferenceIntent,
  mode: CanonicalItemCreateMode, reason?: string, schema = "public",
): Promise<ReferenceReply> {
  requireInventoryIntegration();
  const intent = snapshotCanonicalItemCreateIntent(original);
  validateCanonicalItemCreateMode(mode, reason);
  const referenceSchema = staffIdentitySchemaName(schema);
  return withStaffOperation(pool, session, "inventory.items.create", (client, handle) =>
    runCanonicalInventoryItemCreateLifecycle(client, handle, intent, mode, reason, referenceSchema), referenceSchema);
}

/** Exact-action unit revision; no item-create authority is inferred or required. */
export async function commandCanonicalInventoryUnitRevise(
  pool: DbPool, session: VerifiedDurableSession, original: ReferenceIntent,
  mode: CanonicalUnitReviseMode, reason?: string, schema = "public",
): Promise<ReferenceReply> {
  requireInventoryIntegration();
  const intent = snapshotCanonicalUnitReviseIntent(original);
  validateCanonicalItemCreateMode(mode, reason);
  const referenceSchema = staffIdentitySchemaName(schema);
  return withStaffOperation(pool, session, "inventory.units.revise", (client, handle) =>
    runCanonicalInventoryUnitReviseLifecycle(client, handle, intent, mode, reason, referenceSchema), referenceSchema);
}

/** Existing doctor-party selection is a location binding, not identity authority. */
export async function commandCanonicalInventoryLocationCreate(
  pool: DbPool, session: VerifiedDurableSession, original: ReferenceIntent,
  mode: CanonicalLocationCreateMode, reason?: string, schema = "public",
): Promise<ReferenceReply> {
  requireInventoryIntegration();
  const intent = snapshotCanonicalLocationCreateIntent(original);
  validateCanonicalItemCreateMode(mode, reason);
  const referenceSchema = staffIdentitySchemaName(schema);
  return withStaffOperation(pool, session, "inventory.locations.create", (client, handle) =>
    runCanonicalInventoryLocationCreateLifecycle(client, handle, intent, mode, reason, referenceSchema), referenceSchema);
}

/** Exact-action approval-limit revision (`inventory.approval-policy.manage`). Self-approval
 * remains disabled; the limit is a new immutable version (optimistic version + audit). */
export async function commandCanonicalInventoryPolicyRevise(
  pool: DbPool, session: VerifiedDurableSession, original: ReferenceIntent,
  mode: CanonicalItemCreateMode, reason?: string, schema = "public",
): Promise<ReferenceReply> {
  requireInventoryIntegration();
  const intent = snapshotCanonicalPolicyReviseIntent(original);
  validateCanonicalItemCreateMode(mode, reason);
  const referenceSchema = staffIdentitySchemaName(schema);
  return withStaffOperation(pool, session, "inventory.approval-policy.manage", (client, handle) =>
    runCanonicalInventoryPolicyReviseLifecycle(client, handle, intent, mode, reason, referenceSchema), referenceSchema);
}

// Private bounded SQL shared with the existing admin/journal-restricted setup reader.
// Never export a facts reader accepting a caller-constructed authority projection.
async function readReferenceFacts(client: DbClient, referenceAuthority: ReferenceAuthority,
  allowedActions: readonly ReferenceAction[], query: string, page: number, schema?: string): Promise<ReferenceRead> {
  const prefix = schema === undefined ? "" : `${staffIdentitySchemaName(schema)}.`;
      const items = await client.query<{
        id: number;
        name: string;
        category: string;
        unit: string;
        is_active: boolean;
        version: number | null;
        entered_unit: string | null;
        factor: string | null;
        entered_precision: number | null;
        base_precision: number | null;
      }>(
        `SELECT i.id,i.name,i.category,i.unit,i.is_active,u.version,u.entered_unit,u.factor::text,u.entered_precision,u.base_precision FROM ${prefix}inventory_items i LEFT JOIN LATERAL (SELECT * FROM ${prefix}inventory_item_unit_versions WHERE item_id=i.id ORDER BY version DESC LIMIT 1) u ON TRUE WHERE strpos(lower(i.name),lower($1))>0 ORDER BY i.name,i.id LIMIT 21 OFFSET $2`,
        [query, page * 20],
      );
      const locations = await client.query<{
        id: string;
        label: string;
        kind: string;
        doctor_party_id: number | null;
        is_active: boolean;
      }>(
        `SELECT id,label,kind,doctor_party_id,is_active FROM ${prefix}inventory_locations WHERE branch_key=$1 ORDER BY label,id LIMIT 501`,
        [INVENTORY_CLINIC_SCOPE],
      );
      const doctors = await client.query<{ id: number; name: string }>(
        `SELECT id,name FROM ${prefix}parties WHERE kind='doctor' AND is_active ORDER BY name,id LIMIT 501`,
      );
      invariant(
        locations.rows.length <= 500 && doctors.rows.length <= 500,
        "reference_read_limit",
        "Reference list exceeds the supported bound; no incomplete setup list is shown",
      );
      const policies = await client.query<{
        version: number;
        limit_minor: string;
        allow_self_approval: boolean;
      }>(
        `SELECT version,limit_minor::text,allow_self_approval FROM ${prefix}inventory_approval_policies WHERE branch_key=$1 ORDER BY version DESC LIMIT 1`,
        [INVENTORY_CLINIC_SCOPE],
      );
      const p = policies.rows[0];
      return {
        authority: referenceAuthority,
        allowedActions: [...allowedActions],
        items: items.rows.slice(0, 20).map((i) => ({
          id: i.id,
          name: i.name,
          category: i.category,
          unit: i.unit,
          isActive: i.is_active,
          version: i.version ?? 0,
          enteredUnit: i.entered_unit,
          factor: i.factor,
          enteredPrecision: i.entered_precision,
          basePrecision: i.base_precision,
        })),
        locations: locations.rows.map((l) => ({
          id: l.id,
          label: l.label,
          kind: l.kind,
          doctorPartyId: l.doctor_party_id,
          isActive: l.is_active,
        })),
        doctors: doctors.rows,
        policy: p
          ? {
              version: p.version,
              limitMinor: Number(p.limit_minor),
              allowSelfApproval: p.allow_self_approval,
            }
          : null,
        page,
        hasMore: items.rows.length > 20,
        query,
      };
}

async function write(
  client: DbClient,
  actor: InventoryActor,
  input: ReferenceInput,
): Promise<ReferenceResult> {
  let result: ReferenceResult;
  if (input.action === "item.create") {
    const item = await client.query<{ id: number }>(
      "INSERT INTO inventory_items(name,category,unit,min_level,note,created_by) VALUES($1,$2,$3,$4::numeric,$5,$6) RETURNING id",
      [
        input.name,
        input.category,
        input.baseUnit,
        quantityText(quantityAtoms(input.minLevel, 3, true)),
        input.note || null,
        actor.username,
      ],
    );
    const id = item.rows[0].id;
    await client.query(
      "INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,$2,$2,1,$3,$3)",
      [id, input.baseUnit, input.basePrecision],
    );
    result = { action: input.action, id: String(id), version: 1 };
  } else if (input.action === "unit.revise") {
    const item = await client.query<{ unit: string; is_active: boolean }>(
      "SELECT unit,is_active FROM inventory_items WHERE id=$1 FOR UPDATE",
      [input.itemId],
    );
    invariant(
      item.rows[0]?.is_active,
      "item_unit_mismatch",
      "Select an active inventory item",
    );
    const latest = await client.query<{
      version: number;
      base_precision: number;
    }>(
      "SELECT version,base_precision FROM inventory_item_unit_versions WHERE item_id=$1 ORDER BY version DESC LIMIT 1",
      [input.itemId],
    );
    invariant(
      (latest.rows[0]?.version ?? 0) === input.expectedVersion,
      "stale_version",
      "Refresh the registered conversion version",
    );
    invariant(
      !latest.rows[0] || latest.rows[0].base_precision === input.basePrecision,
      "conversion_version_mismatch",
      "Existing base precision remains fixed",
    );
    const unit = unitConversionSnapshot({
      itemId: input.itemId,
      version: input.expectedVersion + 1,
      enteredUnit: input.enteredUnit,
      baseUnit: item.rows[0].unit,
      baseUnitsPerEnteredUnit: input.factor,
      enteredPrecision: input.enteredPrecision,
      basePrecision: input.basePrecision,
    });
    await client.query(
      "INSERT INTO inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,$2,$3,$4,$5::numeric,$6,$7)",
      [
        unit.itemId,
        unit.version,
        unit.enteredUnit,
        unit.baseUnit,
        unit.baseUnitsPerEnteredUnit,
        unit.enteredPrecision,
        unit.basePrecision,
      ],
    );
    result = {
      action: input.action,
      id: String(input.itemId),
      version: unit.version,
    };
  } else if (input.action === "location.create") {
    if (input.kind === "custody") {
      const doctor = await client.query(
        "SELECT id FROM parties WHERE id=$1 AND kind='doctor' AND is_active FOR SHARE",
        [input.doctorPartyId],
      );
      invariant(
        doctor.rows.length === 1,
        "location_forbidden",
        "Custody requires an active canonical doctor party",
      );
    }
    await client.query(
      "INSERT INTO inventory_locations(id,branch_key,label,kind,doctor_party_id) VALUES($1,$2,$3,$4,$5)",
      [
        input.id,
        INVENTORY_CLINIC_SCOPE,
        input.label,
        input.kind,
        input.doctorPartyId,
      ],
    );
    result = { action: input.action, id: input.id, version: 1 };
  } else {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "inventory.reference.policy:" + INVENTORY_CLINIC_SCOPE,
    ]);
    const current = await client.query<{ version: number }>(
      "SELECT version FROM inventory_approval_policies WHERE branch_key=$1 ORDER BY version DESC LIMIT 1",
      [INVENTORY_CLINIC_SCOPE],
    );
    invariant(
      (current.rows[0]?.version ?? 0) === input.expectedVersion,
      "stale_version",
      "Refresh the approval policy version",
    );
    const version = input.expectedVersion + 1;
    const row = await client.query<{ id: string }>(
      "INSERT INTO inventory_approval_policies(id,branch_key,version,currency,limit_minor,allow_self_approval,created_by) VALUES(gen_random_uuid(),$1,$2,'YER',$3,FALSE,$4) RETURNING id",
      [INVENTORY_CLINIC_SCOPE, version, input.limitMinor, actor.userId],
    );
    result = { action: input.action, id: row.rows[0].id, version };
  }
  await writeInventoryAudit(
    client,
    actor,
    "inventory_reference",
    result.id,
    input.action,
    { ...input, version: result.version },
  );
  return result;
}
