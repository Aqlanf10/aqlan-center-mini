import type { InventoryActor } from "./procurement-store";
import { invariant } from "./quantities";

/** Stable identity supplied only by the canonical authenticated server adapter. */
export interface InventoryPrincipal {
  realmId: string;
  subjectId: string;
  actorUserId: number;
  username: string;
}
export interface InventoryPrincipalDependencies {
  resolvePrincipal: (
    actor: InventoryActor,
  ) => Promise<InventoryPrincipal | null>;
}
export const closedInventoryPrincipalResolver: InventoryPrincipalDependencies =
  {
    resolvePrincipal: async () => null,
  };
export async function resolveInventoryPrincipal(
  dependencies: InventoryPrincipalDependencies,
  actor: InventoryActor,
): Promise<InventoryPrincipal> {
  const principal = await dependencies.resolvePrincipal(actor);
  invariant(
    principal &&
      typeof principal.realmId === "string" &&
      principal.realmId.trim() === principal.realmId &&
      principal.realmId.length > 0 &&
      principal.realmId.length <= 240 &&
      typeof principal.subjectId === "string" &&
      principal.subjectId.trim() === principal.subjectId &&
      principal.subjectId.trim().length > 0 &&
      principal.subjectId.length <= 240 &&
      principal.actorUserId === actor.userId &&
      principal.username === actor.username,
    "principal_realm_unavailable",
    "An authoritative realm and authenticated subject binding are required",
  );
  return Object.freeze({
    realmId: principal.realmId,
    subjectId: principal.subjectId,
    actorUserId: principal.actorUserId,
    username: principal.username,
  });
}
