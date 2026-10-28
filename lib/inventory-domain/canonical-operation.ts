import "server-only";
import type { DbClient, DbPool } from "../db";
import type { VerifiedDurableSession } from "../staff-durable-session";
import {
  assertStaffOperation,
  staffOperationCapabilities,
  staffOperationClinician,
  staffOperationIdentity,
  withStaffOperation,
  type InventoryRuntimeAction,
  type StaffOperationHandle,
} from "../staff-operation-runtime";
import type { StaffCapability } from "../staff-capability-catalogue";
import { lockedAccountHoldsCapability } from "../staff-authority-proof-internal";
import type { InventoryPrincipal } from "./principal";
import { invariant } from "./quantities";
import { requireInventoryIntegration } from "./rollout";

/**
 * Canonical admission for inventory and procurement operations (M3a).
 *
 * Each HTTP command runs inside `withStaffOperation` with its exact catalogue
 * capability. The runtime owns the READ COMMITTED transaction, the shared lifecycle
 * fence and the locked authority proof. The inventory store then receives an opaque
 * authority token instead of a role:
 *  - the token is a frozen object registered in a module-private WeakMap, so it can't
 *    be constructed, copied or serialised into authority;
 *  - it is bound to the exact client, operation handle, action and schema;
 *  - it dies with the operation callback (no escape, no reuse);
 *  - every store boundary re-asserts it (`assertCanonicalInventoryAuthority`), with a
 *    fresh proof before the domain reset fence, after it and after the operation-key
 *    lock, as in `command-lifecycle.ts`.
 *
 * Visibility decisions (financial values, custody oversight, all requests) come from
 * the actor's current grants, read once under the same fences. Role labels never
 * decide anything here.
 */
declare const authorityBrand: unique symbol;
export interface CanonicalInventoryAuthority { readonly [authorityBrand]: true }

/** Capabilities that drive data-visibility decisions inside inventory operations. */
export const INVENTORY_DECISION_CAPABILITIES = Object.freeze([
  "inventory.costs.view",
  "inventory.custody.dispatch",
  "inventory.custody.settlement.propose",
  "inventory.requests.approve",
  "inventory.orders.manage",
  "inventory.reconcile",
] as const satisfies readonly StaffCapability[]);
type DecisionCapability = typeof INVENTORY_DECISION_CAPABILITIES[number];

interface AuthorityState {
  readonly client: DbClient;
  readonly handle: StaffOperationHandle;
  readonly action: InventoryRuntimeAction;
  readonly schema: string;
  readonly userId: number;
  readonly username: string;
  readonly roleLabel: string;
  readonly principal: InventoryPrincipal;
  readonly generationId: string;
  readonly grants: ReadonlySet<DecisionCapability>;
  readonly clinicianPartyId: number | null;
}
const states = new WeakMap<CanonicalInventoryAuthority, AuthorityState>();
/** The admitted transaction client → its live authority. Any inventory check on this
 * client applies canonical proof and grants, never a role policy (stricter, never wider). */
const byClient = new WeakMap<DbClient, CanonicalInventoryAuthority>();
export function canonicalAuthorityOfClient(client: DbClient): CanonicalInventoryAuthority | null {
  const authority = byClient.get(client);
  return authority && states.has(authority) ? authority : null;
}

export function isCanonicalInventoryAuthority(value: unknown): value is CanonicalInventoryAuthority {
  return typeof value === "object" && value !== null && states.has(value as CanonicalInventoryAuthority);
}

function stateOf(authority: CanonicalInventoryAuthority): AuthorityState {
  const state = states.get(authority);
  invariant(state, "operation_forbidden", "Canonical inventory authority is not active");
  return state;
}

/** Fresh exact proof on the owning client. Any drift (revocation, expiry, schema,
 * changed transaction or foreign client) refuses before the caller continues. */
export async function assertCanonicalInventoryAuthority(client: DbClient, authority: CanonicalInventoryAuthority): Promise<AuthorityState> {
  const state = stateOf(authority);
  invariant(state.client === client, "operation_forbidden", "Canonical inventory authority belongs to another transaction");
  await assertStaffOperation(client, state.handle, state.action, state.schema);
  return state;
}

/** Display/audit identity of the admitted actor (role is a label, not a grant). */
export function canonicalInventoryActor(authority: CanonicalInventoryAuthority) {
  const state = stateOf(authority);
  return Object.freeze({ userId: state.userId, username: state.username, role: state.roleLabel });
}
export function canonicalInventoryPrincipal(authority: CanonicalInventoryAuthority): InventoryPrincipal {
  return stateOf(authority).principal;
}
/** Supplier-intent authority triple: canonical realm, subject and the identity
 * generation in which execution is admitted (recovery requirements: "admission
 * execution generation"). Never imported from a source database. */
export function canonicalInventoryAuthorityClaims(authority: CanonicalInventoryAuthority) {
  const state = stateOf(authority);
  return Object.freeze({ realmId: state.principal.realmId, subjectId: state.principal.subjectId, executionEpochId: state.generationId });
}
export function canonicalInventoryClient(authority: CanonicalInventoryAuthority): DbClient {
  return stateOf(authority).client;
}
export function canonicalInventoryGrant(authority: CanonicalInventoryAuthority, capability: DecisionCapability): boolean {
  return stateOf(authority).grants.has(capability);
}
export function canonicalInventoryClinician(authority: CanonicalInventoryAuthority): number | null {
  return stateOf(authority).clinicianPartyId;
}

/** Runs `work` inside one admitted canonical operation for the exact `action`. */
export async function withCanonicalInventoryOperation<T>(
  pool: DbPool,
  session: VerifiedDurableSession,
  action: InventoryRuntimeAction,
  work: (authority: CanonicalInventoryAuthority) => Promise<T>,
  schema = "public",
): Promise<T> {
  requireInventoryIntegration();
  return withStaffOperation(pool, session, action, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, action, schema);
    const grants = await staffOperationCapabilities(client, handle, action, INVENTORY_DECISION_CAPABILITIES, schema);
    const clinicianPartyId = await staffOperationClinician(client, handle, action, schema);
    const authority = Object.freeze({}) as CanonicalInventoryAuthority;
    states.set(authority, Object.freeze({
      client, handle, action, schema,
      userId: identity.userId, username: identity.username, roleLabel: identity.role,
      principal: Object.freeze({ realmId: identity.realmId, subjectId: identity.subjectId, actorUserId: identity.userId, username: identity.username }),
      generationId: identity.generationId,
      grants, clinicianPartyId,
    }));
    byClient.set(client, authority);
    try {
      const result = await work(authority);
      await assertCanonicalInventoryAuthority(client, authority);
      return result;
    } finally {
      states.delete(authority);
      byClient.delete(client);
    }
  }, schema);
}

/** Inside an admitted canonical operation on `client`: does the recorded account
 * `userId` currently prove as an active canonical account holding `capability`?
 * Used for approvals recorded earlier and consumed now (never a role label). */
export async function canonicalAccountHolds(client: DbClient, userId: number, capability: StaffCapability): Promise<boolean> {
  const authority = canonicalAuthorityOfClient(client);
  invariant(authority, "operation_forbidden", "Canonical inventory authority is not active");
  const state = await assertCanonicalInventoryAuthority(client, authority);
  return lockedAccountHoldsCapability(client, userId, capability, state.schema);
}
