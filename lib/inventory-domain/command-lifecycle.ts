import "server-only";
import { createHash } from "node:crypto";
import { insertAuditRow } from "../db";
import { staffIdentitySchemaName } from "../staff-identity-substrate-schema.mjs";
import { assertStaffOperation, staffOperationCapabilities, staffOperationIdentity, type StaffOperationHandle } from "../staff-operation-runtime";
import { PURCHASE_RESET_FENCE } from "../clinic-reset";
import { REFERENCE_PROTOCOL, type ReferenceIntent, type ReferenceReply, type ReferenceResult } from "../inventory-reference-protocol";
import { validateReferenceInput, referenceText } from "./reference-validation";
import { quantityAtoms, quantityText, unitConversionSnapshot } from "./quantities";
import { sanitizeInventoryAuditDetails } from "./presentation";
import type { DbClient } from "../db";
import {
  INVENTORY_CLINIC_SCOPE,
  inventoryOperationInTransaction,
  inventoryOperationDigest,
  withInventoryCommandLockInTransaction,
  writeInventoryAudit,
  type InventoryActor,
} from "./procurement-store";
import {
  closedInventoryPrincipalResolver,
  resolveInventoryPrincipal,
  type InventoryPrincipalDependencies,
} from "./principal";
import {
  readInventoryCommandBinding,
  authorizeInventoryCommandBinding,
} from "./command-fence";
import { payloadIdentity } from "./procurement";
import { invariant } from "./quantities";
import { requireInventoryIntegration } from "./rollout";

/** Constructed by a server command adapter, never read from a request body. */
export interface InventoryCommandDescriptor {
  scope: string;
  management: boolean;
}
export interface InventoryCommandIdentity {
  scope: string;
  actorUserId: number;
  username: string;
  operationKey: string;
  payloadDigest: string;
  realmId: string;
  subjectId: string;
}
export type InventoryCommandOutcome<
  T extends object = Record<string, unknown>,
> =
  | {
      status: "committed";
      identity: InventoryCommandIdentity;
      result: T & { replayed: boolean };
    }
  | { status: "retired"; identity: InventoryCommandIdentity; reason: string };

function snapshot<P>(payload: P): P {
  const identity = payloadIdentity(payload);
  const copied = JSON.parse(identity.slice("inventory-json-v1:".length)) as P;
  function freeze(value: unknown) {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(copied);
  return copied;
}

/** Prepared core: no HTTP/UI adapter. The caller owns one explicit transaction.
 * Admit only fresh intent, commit it before future execution, and never use this
 * admission API to manufacture provenance for an old unresolved browser journal.
 * Domain work must be an unjournaled transaction body, not another store command. */
export function createInventoryCommandLifecycle(
  descriptor: InventoryCommandDescriptor,
  dependencies: InventoryPrincipalDependencies = closedInventoryPrincipalResolver,
) {
  return createLifecycle(descriptor, dependencies);
}

// This context is never accepted by an exported generic lifecycle constructor.
// A genuine exact-action handle, not actor/role/projection, supplies authority.
const canonicalCapabilities = Object.freeze({
  "item.create": "inventory.items.create",
  "unit.revise": "inventory.units.revise",
  "location.create": "inventory.locations.create",
  "policy.revise": "inventory.approval-policy.manage",
} as const);
type CanonicalReferenceAction = keyof typeof canonicalCapabilities;
interface CanonicalReferenceContext { handle: StaffOperationHandle; schema: string; action: CanonicalReferenceAction }
function createLifecycle(
  descriptor: InventoryCommandDescriptor,
  dependencies: InventoryPrincipalDependencies,
  canonical?: CanonicalReferenceContext,
) {
  invariant(
    typeof descriptor.scope === "string" &&
      /^[a-z][a-z0-9_.:-]{0,159}$/.test(descriptor.scope),
    "invalid_command_scope",
    "A bounded server-owned ASCII command namespace is required",
  );
  invariant(
    typeof descriptor.management === "boolean",
    "invalid_command_policy",
    "A server command policy is required",
  );
  const { scope, management } = descriptor;
  const prefix = canonical ? `${staffIdentitySchemaName(canonical.schema)}.` : "";
  async function assertCanonical(client: DbClient) {
    if (canonical) await assertStaffOperation(client, canonical.handle, canonicalCapabilities[canonical.action], canonical.schema);
  }
  async function audit(client: DbClient, actor: InventoryActor, entity: string, id: string, operation: string, details: Record<string, unknown>) {
    if (!canonical) return writeInventoryAudit(client, actor, entity, id, operation, details);
    // Financial audit detail follows the actor's current cost grant, never a role label.
    const includeFinancials = (await staffOperationCapabilities(client, canonical.handle, canonicalCapabilities[canonical.action], ["inventory.costs.view"], canonical.schema)).has("inventory.costs.view");
    // insertAuditRow gathers request metadata asynchronously. Reassert at the SQL
    // boundary, after that await, rather than only before constructing the audit.
    await insertAuditRow({query: async (sql, values) => {
      await assertCanonical(client);
      return client.query(sql, values);
    }}, {action: "inventory.item", entity, entityId: id, entityLabel: id,
      actor: actor.username, actorRole: actor.role,
      details: sanitizeInventoryAuditDetails({operation, ...details}, {includeFinancials})}, canonical.schema);
  }
  async function commandLock<T>(client: DbClient, actor: InventoryActor, key: string, payload: unknown, work: (hash: string) => Promise<T>): Promise<T> {
    if (!canonical) return withInventoryCommandLockInTransaction(client, actor, key, scope, payload, management, work);
    // Central lifecycle/account/provider locks were established by the runtime.
    // Repeat proof before the domain fence and after each possibly blocking lock.
    await assertCanonical(client);
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [PURCHASE_RESET_FENCE]);
    await assertCanonical(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([scope, actor.userId, key])]);
    await assertCanonical(client);
    return work(inventoryOperationDigest(key, payload));
  }

  async function locked<P, T>(
    client: DbClient,
    actor: InventoryActor,
    key: string,
    payload: P,
    admit: boolean,
    work: (context: {
      identity: InventoryCommandIdentity;
      savedPayload: P;
      previous: Record<string, unknown> | null;
      terminal: { reason: string } | null;
      principal: Awaited<ReturnType<typeof resolveInventoryPrincipal>>;
    }) => Promise<T>,
  ) {
    const savedPayload = snapshot(payload);
    requireInventoryIntegration();
    const principal = await resolveInventoryPrincipal(dependencies, actor);
    return commandLock(
      client,
      actor,
      key,
      savedPayload,
      async (hash) => {
        let binding = await readInventoryCommandBinding(
          client,
          actor,
          key,
          scope,
          true,
          canonical?.schema,
        );
        const previous = (
          await client.query<{
            payload_hash: string;
            result: Record<string, unknown>;
          }>(
            `SELECT payload_hash,result FROM ${prefix}inventory_operations WHERE scope=$1 AND actor_id=$2 AND operation_key=$3`,
            [scope, actor.userId, key],
          )
        ).rows[0];
        if (!binding) {
          invariant(
            !previous && admit,
            "command_provenance_required",
            "Legacy or unadmitted commands cannot be adopted, executed or retired",
          );
          await assertCanonical(client);
          await client.query(
            `INSERT INTO ${prefix}inventory_command_bindings(scope,actor_id,operation_key,payload_hash,realm_id,subject_id,username,management) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              scope,
              actor.userId,
              key,
              hash,
              principal.realmId,
              principal.subjectId,
              principal.username,
              management,
            ],
          );
          await audit(
            client,
            actor,
            "inventory_command",
            key,
            "admit",
            {
              scope,
              digest: hash,
              realmId: principal.realmId,
              subjectId: principal.subjectId,
            },
          );
          binding = {
            payload_hash: hash,
            realm_id: principal.realmId,
            subject_id: principal.subjectId,
            username: principal.username,
            management,
            admitted_in_current_transaction: true,
          };
        }
        if (canonical) {
          // This first binding has no historical rename-continuity contract.
          // Refuse a changed username; never rewrite original admission evidence.
          invariant(binding.realm_id === principal.realmId && binding.subject_id === principal.subjectId && binding.username === actor.username,
            "command_provenance_required", "This command belongs to another admitted identity or username");
          invariant(binding.payload_hash === hash, "idempotency_conflict", "This operation key already identifies different content");
          invariant(binding.management === true, "command_policy_mismatch", "Command admission policy cannot be replaced");
        } else authorizeInventoryCommandBinding(binding, actor, hash, management, principal);
        invariant(
          admit || binding.admitted_in_current_transaction === false,
          "command_admission_uncommitted",
          "Admission must commit before execution or retirement",
        );
        if (previous)
          invariant(
            previous.payload_hash === hash,
            "idempotency_conflict",
            "Committed content differs from this exact command",
          );
        const identity: InventoryCommandIdentity = {
          scope,
          actorUserId: actor.userId,
          username: canonical ? binding.username : actor.username,
          operationKey: key,
          payloadDigest: hash,
          realmId: principal.realmId,
          subjectId: principal.subjectId,
        };
        // Historical committed acknowledgement always wins; no error inference.
        const terminal = previous
          ? null
          : ((
              await client.query<{ reason: string }>(
                `SELECT reason FROM ${prefix}inventory_command_retirements WHERE scope=$1 AND actor_id=$2 AND operation_key=$3`,
                [scope, actor.userId, key],
              )
            ).rows[0] ?? null);
        return work({
          identity,
          savedPayload,
          previous: previous?.result ?? null,
          terminal,
          principal,
        });
      },
    );
  }

  return {
    /** Authorized recovery only: absence is pending, never proof of failure. */
    lookup<P>(
      client: DbClient,
      actor: InventoryActor,
      key: string,
      payload: P,
    ) {
      return locked(
        client,
        actor,
        key,
        payload,
        false,
        async ({ identity, previous, terminal }) => {
          if (previous)
            return {
              status: "committed" as const,
              identity,
              result: { ...previous, replayed: true },
            };
          if (terminal)
            return {
              status: "retired" as const,
              identity,
              reason: terminal.reason,
            };
          return { status: "pending" as const, identity };
        },
      );
    },
    admit<P>(client: DbClient, actor: InventoryActor, key: string, payload: P) {
      return locked(
        client,
        actor,
        key,
        payload,
        true,
        async ({ identity, previous, terminal }) => {
          if (previous)
            return {
              status: "committed" as const,
              identity,
              result: { ...previous, replayed: true },
            };
          if (terminal)
            return {
              status: "retired" as const,
              identity,
              reason: terminal.reason,
            };
          return { status: "admitted" as const, identity };
        },
      );
    },
    execute<P, T extends object>(
      client: DbClient,
      actor: InventoryActor,
      key: string,
      payload: P,
      work: (client: DbClient, savedPayload: P) => Promise<T>,
    ): Promise<InventoryCommandOutcome<T>> {
      return locked(
        client,
        actor,
        key,
        payload,
        false,
        async ({ identity, savedPayload, previous, terminal, principal }) => {
          if (previous)
            return {
              status: "committed",
              identity,
              result: { ...previous, replayed: true } as T & {
                replayed: boolean;
              },
            };
          if (terminal)
            return { status: "retired", identity, reason: terminal.reason };
          if (canonical) {
            await assertCanonical(client);
            const result = await work(client, savedPayload);
            await assertCanonical(client);
            await client.query(`INSERT INTO ${prefix}inventory_operations(scope,actor_id,operation_key,payload_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)`,
              [scope, actor.userId, key, identity.payloadDigest, JSON.stringify(result)]);
            return {status: "committed", identity, result: {...result, replayed: false}};
          }
          const result = await inventoryOperationInTransaction(
            client,
            actor,
            key,
            scope,
            savedPayload,
            management,
            (c) => work(c, savedPayload),
            principal,
          );
          return { status: "committed", identity, result };
        },
      );
    },
    retire<P>(
      client: DbClient,
      actor: InventoryActor,
      key: string,
      payload: P,
      reason: string,
    ): Promise<InventoryCommandOutcome> {
      invariant(
        typeof reason === "string" &&
          reason.trim().length >= 3 &&
          reason.length <= 2000,
        "reason_required",
        "An explicit bounded retirement reason is required",
      );
      return locked(
        client,
        actor,
        key,
        payload,
        false,
        async ({ identity, previous, terminal }) => {
          if (previous)
            return {
              status: "committed",
              identity,
              result: { ...previous, replayed: true },
            };
          if (terminal)
            return { status: "retired", identity, reason: terminal.reason };
          await assertCanonical(client);
          await client.query(
            `INSERT INTO ${prefix}inventory_command_retirements(scope,actor_id,operation_key,payload_hash,reason) VALUES($1,$2,$3,$4,$5)`,
            [scope, actor.userId, key, identity.payloadDigest, reason],
          );
          await audit(
            client,
            actor,
            "inventory_command",
            key,
            "retire",
            {
              scope,
              digest: identity.payloadDigest,
              realmId: identity.realmId,
              subjectId: identity.subjectId,
              reason,
            },
          );
          return { status: "retired", identity, reason };
        },
      );
    },
  };
}

export type CanonicalItemCreateMode = "admit" | "execute" | "lookup" | "retire";
/** Pure immutable validation. No nonce, generation, username or evidence rewrite. */
function snapshotCanonicalReferenceIntent(raw: ReferenceIntent, action: CanonicalReferenceAction): ReferenceIntent {
  const intent = snapshot(raw);
  invariant(intent && typeof intent === "object" &&
    Object.keys(intent).sort().join(",") === "authority,input,nonce,protocol" &&
    intent.protocol === REFERENCE_PROTOCOL &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(intent.nonce),
    "invalid_document", "Invalid original reference intent");
  invariant(intent.authority && Object.keys(intent.authority).sort().join(",") === "generation,realmId,subjectId",
    "invalid_document", "Invalid original authority envelope");
  referenceText(intent.authority.realmId, 240, "realm");
  referenceText(intent.authority.subjectId, 240, "subject");
  referenceText(intent.authority.generation, 240, "generation");
  validateReferenceInput(intent.input);
  invariant(intent.input.action === action, "operation_forbidden", "This canonical wrapper requires its exact reference action");
  return intent;
}
export function snapshotCanonicalItemCreateIntent(raw: ReferenceIntent): ReferenceIntent {
  return snapshotCanonicalReferenceIntent(raw, "item.create");
}
export function snapshotCanonicalUnitReviseIntent(raw: ReferenceIntent): ReferenceIntent {
  return snapshotCanonicalReferenceIntent(raw, "unit.revise");
}
export function snapshotCanonicalLocationCreateIntent(raw: ReferenceIntent): ReferenceIntent {
  return snapshotCanonicalReferenceIntent(raw, "location.create");
}
export function snapshotCanonicalPolicyReviseIntent(raw: ReferenceIntent): ReferenceIntent {
  return snapshotCanonicalReferenceIntent(raw, "policy.revise");
}
export type CanonicalUnitReviseMode = CanonicalItemCreateMode;
export type CanonicalLocationCreateMode = CanonicalItemCreateMode;
export function validateCanonicalItemCreateMode(mode: CanonicalItemCreateMode, reason?: string): void {
  invariant(["admit", "execute", "lookup", "retire"].includes(mode), "invalid_document", "Unknown item-create command mode");
  if (mode === "retire") invariant(typeof reason === "string" && reason.trim().length >= 3 && reason.length <= 2000,
    "reason_required", "An explicit bounded retirement reason is required");
}

/** Narrow genuine-handle facade to the SAME admission/replay/retirement core.
 * No arbitrary namespace, policy, actor, principal, authority callback or domain
 * callback can be supplied. The owning server wrapper commits each mode alone.
 * Exposed for trusted transaction composition/tests, never as an HTTP endpoint.
 * Callers MUST roll back on any failure, including uncertain SQL/transport errors;
 * catching an exception never establishes that this transaction is safe to commit. */
async function runCanonicalReferenceLifecycle(
  action: CanonicalReferenceAction, client: DbClient, handle: StaffOperationHandle, raw: ReferenceIntent,
  mode: CanonicalItemCreateMode, reason?: string, schema = "public",
): Promise<ReferenceReply> {
  requireInventoryIntegration();
  const intent = snapshotCanonicalReferenceIntent(raw, action);
  validateCanonicalItemCreateMode(mode, reason);
  const s = staffIdentitySchemaName(schema);
  const capability = canonicalCapabilities[action];
  const current = await staffOperationIdentity(client, handle, capability, s);
  invariant(intent.authority.realmId === current.realmId && intent.authority.subjectId === current.subjectId,
    "reference_identity_mismatch", "Saved setup identity must not be rewritten or adopted");
  invariant(intent.authority.generation === current.generationId,
    "reference_generation_mismatch", "The original execution generation is no longer current");
  // Reviewed proposal trigger bodies use unqualified internal references. Bind
  // their transaction-local resolution to the SAME validated authority schema;
  // outer queries remain explicitly qualified. Never change a pool-global path.
  const {rows: [settings]} = await client.query<{path: string}>("SELECT current_setting('search_path') AS path");
  await client.query("SELECT set_config('search_path',$1,true)", [`pg_catalog,${s},pg_temp`]);
  let completed = false;
  try {
  const actor: InventoryActor = {userId: current.userId, username: current.username, role: current.role};
  const principal = Object.freeze({realmId: current.realmId, subjectId: current.subjectId, actorUserId: current.userId, username: current.username});
  const key = `reference:${createHash("sha256").update(JSON.stringify([intent.authority.realmId, intent.authority.subjectId, intent.nonce])).digest("hex")}`;
  const canonical = {handle, schema: s, action};
  const lifecycle = createLifecycle({scope: "reference.setup", management: true}, {resolvePrincipal: async () => principal}, canonical);
  const outcome = mode === "admit" ? await lifecycle.admit(client, actor, key, intent)
    : mode === "lookup" ? await lifecycle.lookup(client, actor, key, intent)
    : mode === "retire" ? await lifecycle.retire(client, actor, key, intent, reason!)
    : await lifecycle.execute(client, actor, key, intent, async (c, saved): Promise<ReferenceResult> => {
      const input = saved.input;
      invariant(input.action === action, "operation_forbidden", "This canonical wrapper requires its exact reference action");
      await assertStaffOperation(c, handle, capability, s);
      let result: ReferenceResult;
      if (input.action === "item.create") {
        const {rows: [item]} = await c.query<{id: number}>(
          `INSERT INTO ${s}.inventory_items(name,category,unit,min_level,note,created_by) VALUES($1,$2,$3,$4::numeric,$5,$6) RETURNING id`,
          [input.name,input.category,input.baseUnit,quantityText(quantityAtoms(input.minLevel,3,true)),input.note || null,actor.username]);
        await assertStaffOperation(c, handle, capability, s);
        await c.query(`INSERT INTO ${s}.inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,1,$2,$2,1,$3,$3)`,
          [item.id,input.baseUnit,input.basePrecision]);
        result = {action: input.action, id: String(item.id), version: 1};
      } else if (input.action === "unit.revise") {
        const {rows: [item]} = await c.query<{unit: string; is_active: boolean}>(
          `SELECT unit,is_active FROM ${s}.inventory_items WHERE id=$1 FOR UPDATE`, [input.itemId]);
        await assertStaffOperation(c, handle, capability, s);
        invariant(item?.is_active, "item_unit_mismatch", "Select an active inventory item");
        const {rows: [latest]} = await c.query<{version: number; base_unit: string; base_precision: number}>(
          `SELECT version,base_unit,base_precision FROM ${s}.inventory_item_unit_versions WHERE item_id=$1 ORDER BY version DESC LIMIT 1`, [input.itemId]);
        invariant((latest?.version ?? 0) === input.expectedVersion, "stale_version", "Refresh the registered conversion version");
        invariant(!latest || (latest.base_precision === input.basePrecision && latest.base_unit === item.unit),
          "conversion_version_mismatch", "Existing base unit and precision remain fixed");
        const unit = unitConversionSnapshot({itemId: input.itemId, version: input.expectedVersion + 1,
          enteredUnit: input.enteredUnit, baseUnit: item.unit, baseUnitsPerEnteredUnit: input.factor,
          enteredPrecision: input.enteredPrecision, basePrecision: input.basePrecision});
        await assertStaffOperation(c, handle, capability, s);
        await c.query(`INSERT INTO ${s}.inventory_item_unit_versions(item_id,version,entered_unit,base_unit,factor,entered_precision,base_precision) VALUES($1,$2,$3,$4,$5::numeric,$6,$7)`,
          [unit.itemId,unit.version,unit.enteredUnit,unit.baseUnit,unit.baseUnitsPerEnteredUnit,unit.enteredPrecision,unit.basePrecision]);
        result = {action: input.action, id: String(input.itemId), version: unit.version};
      } else if (input.action === "policy.revise") {
        // Same serialization as the legacy setup writer; self-approval stays disabled.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["inventory.reference.policy:" + INVENTORY_CLINIC_SCOPE]);
        await assertStaffOperation(c, handle, capability, s);
        const {rows: [latest]} = await c.query<{version: number}>(
          `SELECT version FROM ${s}.inventory_approval_policies WHERE branch_key=$1 ORDER BY version DESC LIMIT 1`, [INVENTORY_CLINIC_SCOPE]);
        invariant((latest?.version ?? 0) === input.expectedVersion, "stale_version", "Refresh the approval policy version");
        const version = input.expectedVersion + 1;
        await assertStaffOperation(c, handle, capability, s);
        const {rows: [row]} = await c.query<{id: string}>(
          `INSERT INTO ${s}.inventory_approval_policies(id,branch_key,version,currency,limit_minor,allow_self_approval,created_by) VALUES(gen_random_uuid(),$1,$2,'YER',$3,FALSE,$4) RETURNING id`,
          [INVENTORY_CLINIC_SCOPE, version, input.limitMinor, actor.userId]);
        result = {action: input.action, id: row.id, version};
      } else {
        invariant(input.action === "location.create", "operation_forbidden", "Unsupported canonical reference action");
        if (input.kind === "custody") {
          const doctor = await c.query(`SELECT id FROM ${s}.parties WHERE id=$1 AND kind='doctor' AND is_active FOR SHARE`, [input.doctorPartyId]);
          await assertStaffOperation(c, handle, capability, s);
          invariant(doctor.rows.length === 1, "location_forbidden", "Custody requires an active canonical doctor party");
        }
        await assertStaffOperation(c, handle, capability, s);
        await c.query(`INSERT INTO ${s}.inventory_locations(id,branch_key,label,kind,doctor_party_id) VALUES($1,$2,$3,$4,$5)`,
          [input.id,INVENTORY_CLINIC_SCOPE,input.label,input.kind,input.doctorPartyId]);
        result = {action: input.action, id: input.id, version: 1};
      }
      const includeFinancials = (await staffOperationCapabilities(c, handle, capability, ["inventory.costs.view"], s)).has("inventory.costs.view");
      await insertAuditRow({query: async (sql, values) => {
        await assertStaffOperation(c, handle, capability, s);
        return c.query(sql, values);
      }}, {action: "inventory.item", entity: "inventory_reference", entityId: result.id, entityLabel: result.id,
        actor: actor.username, actorRole: actor.role,
        details: sanitizeInventoryAuditDetails({operation: input.action, ...input, version: result.version}, {includeFinancials})}, s);
      return result;
    });
  completed = true;
  return {...outcome, intent} as ReferenceReply;
  } finally {
    if (completed) {
      // The lower facade may return to another trusted transaction participant.
      await client.query("SELECT set_config('search_path',$1,true)", [settings.path]);
    } else {
      // A SQL failure may have aborted the transaction; preserve its original
      // error. Transaction rollback also restores all SET LOCAL configuration.
      try { await client.query("SELECT set_config('search_path',$1,true)", [settings.path]); } catch { /* caller must roll back */ }
    }
  }
}

// Separate exact-action facades: adjacent actions cannot borrow another handle.
export async function runCanonicalInventoryItemCreateLifecycle(
  client: DbClient, handle: StaffOperationHandle, raw: ReferenceIntent,
  mode: CanonicalItemCreateMode, reason?: string, schema = "public",
): Promise<ReferenceReply> {
  return runCanonicalReferenceLifecycle("item.create", client, handle, raw, mode, reason, schema);
}
export async function runCanonicalInventoryUnitReviseLifecycle(
  client: DbClient, handle: StaffOperationHandle, raw: ReferenceIntent,
  mode: CanonicalUnitReviseMode, reason?: string, schema = "public",
): Promise<ReferenceReply> {
  return runCanonicalReferenceLifecycle("unit.revise", client, handle, raw, mode, reason, schema);
}
export async function runCanonicalInventoryLocationCreateLifecycle(
  client: DbClient, handle: StaffOperationHandle, raw: ReferenceIntent,
  mode: CanonicalLocationCreateMode, reason?: string, schema = "public",
): Promise<ReferenceReply> {
  return runCanonicalReferenceLifecycle("location.create", client, handle, raw, mode, reason, schema);
}
export async function runCanonicalInventoryPolicyReviseLifecycle(
  client: DbClient, handle: StaffOperationHandle, raw: ReferenceIntent,
  mode: CanonicalItemCreateMode, reason?: string, schema = "public",
): Promise<ReferenceReply> {
  return runCanonicalReferenceLifecycle("policy.revise", client, handle, raw, mode, reason, schema);
}
