import type { DbClient } from "../db";
import {
  inventoryOperationInTransaction,
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
    return withInventoryCommandLockInTransaction(
      client,
      actor,
      key,
      scope,
      savedPayload,
      management,
      async (hash) => {
        let binding = await readInventoryCommandBinding(
          client,
          actor,
          key,
          scope,
          true,
        );
        const previous = (
          await client.query<{
            payload_hash: string;
            result: Record<string, unknown>;
          }>(
            "SELECT payload_hash,result FROM inventory_operations WHERE scope=$1 AND actor_id=$2 AND operation_key=$3",
            [scope, actor.userId, key],
          )
        ).rows[0];
        if (!binding) {
          invariant(
            !previous && admit,
            "command_provenance_required",
            "Legacy or unadmitted commands cannot be adopted, executed or retired",
          );
          await client.query(
            "INSERT INTO inventory_command_bindings(scope,actor_id,operation_key,payload_hash,realm_id,subject_id,username,management) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
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
          await writeInventoryAudit(
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
        authorizeInventoryCommandBinding(
          binding,
          actor,
          hash,
          management,
          principal,
        );
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
          username: actor.username,
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
                "SELECT reason FROM inventory_command_retirements WHERE scope=$1 AND actor_id=$2 AND operation_key=$3",
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
          await client.query(
            "INSERT INTO inventory_command_retirements(scope,actor_id,operation_key,payload_hash,reason) VALUES($1,$2,$3,$4,$5)",
            [scope, actor.userId, key, identity.payloadDigest, reason],
          );
          await writeInventoryAudit(
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
